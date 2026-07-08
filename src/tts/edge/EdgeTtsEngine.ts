import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import {
  cacheDirectory,
  writeAsStringAsync,
  deleteAsync,
  EncodingType,
} from 'expo-file-system/legacy';
import type { TtsEngine, SpeakParams, SpeakHandlers, EngineVoice } from '../TtsEngine';
import {
  WSS_URL,
  WSS_HEADERS,
  SEC_MS_GEC_VERSION,
  TICKS_PER_MS,
  generateSecMsGec,
  connectId,
  muidCookie,
  buildSsml,
  speechConfigMessage,
  ssmlMessage,
  unescapeXml,
  bytesToBase64,
} from './protocol';
import { EDGE_VOICES, defaultEdgeVoice, resolveEdgeVoice } from './voices';
import { edgeSsmlRatePct, edgePlaybackRate } from './rate';

type Word = { text: string; offsetMs: number };
type Boundary = { ms: number; charIndex: number; charLen: number };
type Synth = { uri: string; boundaries: Boundary[] };
type SynthState = { cancelled: boolean; ws: WebSocket | null; uri: string | null };
// player: 합성 완료 시 미리 생성·prepare·배속 적용해 둔 재생기(프리로드) — 문장 전환이 play()
// 한 번으로 끝나 시작 지연이 사라진다. disposed: cancel 이후 뒤늦은 프리로드 생성 차단.
type CacheEntry = {
  promise: Promise<Synth>;
  cancel: () => void;
  player?: AudioPlayer;
  disposed?: boolean;
};

// 프리로드된(아직 재생 전) 플레이어 해제 — 여러 경합 지점에서 부르므로 멱등.
function releasePreload(entry: CacheEntry): void {
  const p = entry.player;
  if (!p) return;
  entry.player = undefined;
  try { p.remove(); } catch { /* noop */ }
}

const CONNECT_TIMEOUT_MS = 8000;
// 연결 후 합성 전체(오디오 수신 완료까지)의 상한. 기존엔 연결 타이머가 끝까지 살아 있어
// 8초 넘는 정상 합성(긴 문장·느린 망)도 "연결 시간 초과"로 오탐 종료됐다 → 단계별 타이머로 분리.
const SYNTH_TIMEOUT_MS = 25000;
// 재생 중 유닛 1 + 선행 합성 3(player.ts PREFETCH_UNITS) — 배속에서 파이프라인이 마르지 않는 깊이.
const MAX_CACHE = 4;
// 네이티브 상태 이벤트 주기(ms). PiP(작은 창)에선 Android가 액티비티를 pause시켜 JS 타이머가
// 얼어붙는다 — 이 이벤트는 액티비티 생명주기와 무관한 코루틴에서 계속 도착해 자막을 움직인다.
const STATUS_UPDATE_MS = 80;

// Edge(Read Aloud) 온라인 신경망 엔진. 문장 하나 = WebSocket 요청 하나(오디오+단어타이밍) →
// 파일로 받아 expo-audio 로 재생, 재생위치를 폴링해 기존 onBoundary 콜백으로 단어 하이라이트.
//
// 문장 간 딜레이 제거: prefetch(다음문장)로 재생 중 미리 합성해 캐시 → 넘어갈 때 즉시 재생.
// synthesize 는 로컬 ws 만 쓰므로(인스턴스 필드 미사용) 재생 중 다른 문장 합성이 동시에 돌 수 있다.
// playGen: speak/stop 마다 증가해, 지연된 재생 시작이 자기 세대가 아니면 무시(오디오 중첩 방지).
export class EdgeTtsEngine implements TtsEngine {
  readonly id = 'edge';
  readonly offline = false;

  private playGen = 0;
  // 재생 전용 필드(현재 울리는 문장 하나)
  private player: AudioPlayer | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private statusSub: { remove: () => void } | null = null;
  private currentUri: string | null = null;
  // 현재 speak가 재생을 기다리는 중인 합성(아직 재생 전). teardown 시 취소해 낭비되는 WS를 끊는다.
  private pendingSynth: CacheEntry | null = null;
  // 선행 합성 캐시(key=voice|rate|lang|text)
  private cache = new Map<string, CacheEntry>();

  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void {
    const myGen = ++this.playGen;
    this.teardownPlayback();
    const key = this.keyOf(text, params);
    let entry = this.cache.get(key);
    if (entry) this.cache.delete(key); // 소비: 이 파일의 소유권을 재생 쪽으로 이전
    else entry = this.makeSynth(text, params);
    this.pendingSynth = entry;

    entry.promise.then(
      (synth) => {
        if (this.pendingSynth === entry) this.pendingSynth = null;
        if (myGen !== this.playGen) {
          releasePreload(entry);
          deleteAsync(synth.uri, { idempotent: true }).catch(() => { /* noop */ });
          return;
        }
        const preloaded = entry.player;
        entry.player = undefined; // 소유권을 재생 쪽으로 이전(이후 cancel이 건드리지 않게)
        this.playFile(synth, params, handlers, myGen, preloaded);
      },
      (err) => {
        if (this.pendingSynth === entry) this.pendingSynth = null;
        if (myGen !== this.playGen) return;
        if (String(err?.message) === 'cancelled') return;
        this.teardownPlayback();
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  prefetch(text: string, params: SpeakParams): void {
    if (!cacheDirectory) return;
    const key = this.keyOf(text, params);
    if (this.cache.has(key)) return;
    const base = this.makeSynth(text, params);
    // cancel 확장: 프리로드된 플레이어까지 함께 해제(축출·정지 시 네이티브 자원 누수 방지).
    const entry: CacheEntry = {
      promise: base.promise,
      cancel: () => {
        entry.disposed = true;
        releasePreload(entry);
        base.cancel();
      },
    };
    // 실패한 선행합성은 캐시에서 즉시 제거 — 남겨두면 일시적 네트워크 오류가
    // 소비 시점의 무조건 폴백으로 굳어진다(재시도 기회 박탈). unhandled rejection 방지 겸용.
    entry.promise.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    // 프리로드: 합성이 끝나는 즉시 플레이어 생성(+prepare)·배속 적용까지 마쳐 둔다.
    // 문장 전환 때 하던 이 작업(수십~수백 ms)이 문장 시작의 "머뭇거림"이었다(2026-07-08).
    // 이 .then은 speak의 소비 .then보다 먼저 등록돼 항상 먼저 실행된다(등록 순서 보장).
    entry.promise
      .then((synth) => {
        if (entry.disposed || entry.player) return;
        try {
          const p = createAudioPlayer(synth.uri, { updateInterval: STATUS_UPDATE_MS });
          try { (p as any).shouldCorrectPitch = true; } catch { /* noop */ }
          try { p.setPlaybackRate(edgePlaybackRate(params.rate)); } catch { /* noop */ }
          // 이 콜백은 전부 동기라 disposed 체크(위)와 대입 사이에 cancel이 끼어들 수 없다.
          entry.player = p;
        } catch { /* 프리로드 실패는 무해 — 재생 시점에 새로 만든다 */ }
      })
      .catch(() => { /* 합성 실패는 위 catch가 처리 */ });
    this.cache.set(key, entry);
    this.evict();
  }

  stop(): void {
    this.playGen++;
    this.teardownPlayback();
    this.clearCache();
  }

  async getVoices(): Promise<EngineVoice[]> {
    return EDGE_VOICES;
  }

  // 배속 매핑: 재생속도(피치 보정) 우선, 초과분만 SSML — 분담 로직은 rate.ts(순수 함수, 테스트 있음).
  // 단어 타이밍은 SSML 타임라인 기준이라 재생속도를 얹어도 currentTime(미디어 위치)과 그대로 일치한다.

  // ── 캐시/합성 라이프사이클 ─────────────────────────────
  private keyOf(text: string, params: SpeakParams): string {
    const voice = params.voiceId || defaultEdgeVoice(params.language);
    return `${voice}\u0000${edgeSsmlRatePct(params.rate)}\u0000${params.language || 'ko-KR'}\u0000${text}`;
  }

  private makeSynth(text: string, params: SpeakParams): CacheEntry {
    const state: SynthState = { cancelled: false, ws: null, uri: null };
    const cancel = () => {
      state.cancelled = true;
      if (state.ws) {
        try { state.ws.onopen = null; state.ws.onmessage = null; state.ws.onerror = null; state.ws.onclose = null; state.ws.close(); } catch { /* noop */ }
        state.ws = null;
      }
      if (state.uri) { const u = state.uri; state.uri = null; deleteAsync(u, { idempotent: true }).catch(() => { /* noop */ }); }
    };
    return { promise: this.synthesize(text, params, state), cancel };
  }

  private evict(): void {
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const e = this.cache.get(oldest);
      this.cache.delete(oldest);
      e?.cancel();
    }
  }

  private clearCache(): void {
    for (const e of this.cache.values()) e.cancel();
    this.cache.clear();
  }

  private teardownPlayback(): void {
    // 아직 재생 안 된 진행 중 합성이 있으면 취소(WS 즉시 종료, 낭비 방지).
    if (this.pendingSynth) { this.pendingSynth.cancel(); this.pendingSynth = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.statusSub) { try { this.statusSub.remove(); } catch { /* noop */ } this.statusSub = null; }
    if (this.player) { try { this.player.pause(); this.player.remove(); } catch { /* noop */ } this.player = null; }
    if (this.currentUri) { const u = this.currentUri; this.currentUri = null; deleteAsync(u, { idempotent: true }).catch(() => { /* noop */ }); }
  }

  private mapBoundaries(text: string, words: Word[]): Boundary[] {
    let cursor = 0;
    const out: Boundary[] = [];
    for (const w of words) {
      const t = unescapeXml(w.text);
      if (!t) { out.push({ ms: w.offsetMs, charIndex: cursor, charLen: 0 }); continue; }
      const idx = text.indexOf(t, cursor);
      if (idx >= 0) { cursor = idx + t.length; out.push({ ms: w.offsetMs, charIndex: idx, charLen: t.length }); }
      else out.push({ ms: w.offsetMs, charIndex: cursor, charLen: 0 });
    }
    return out;
  }

  // 문장 → (오디오 파일 + 단어 경계). 로컬 ws 로 자기완결(재생과 독립, 동시 실행 가능).
  private async synthesize(text: string, params: SpeakParams, state: SynthState): Promise<Synth> {
    const voiceId = params.voiceId || defaultEdgeVoice(params.language);
    const { voice, pitch } = resolveEdgeVoice(voiceId); // 가상 음성(#child 등)은 기본음성+pitch 변조로 해석
    const ssml = buildSsml(text, voice, params.language || 'ko-KR', edgeSsmlRatePct(params.rate), pitch);
    const reqId = connectId();
    const token = await generateSecMsGec();
    if (state.cancelled) throw new Error('cancelled');

    const audioChunks: Uint8Array[] = [];
    const words: Word[] = [];

    return await new Promise<Synth>((resolve, reject) => {
      const url =
        `${WSS_URL}&ConnectionId=${connectId()}` +
        `&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
      const headers = { ...WSS_HEADERS, Cookie: muidCookie() };
      const ws = new (WebSocket as any)(url, undefined, { headers }) as WebSocket;
      (ws as any).binaryType = 'arraybuffer';
      state.ws = ws;

      let settled = false;
      let timer = setTimeout(() => done(new Error('Edge TTS 연결 시간 초과')), CONNECT_TIMEOUT_MS);
      const done = (err: Error | null, synth?: Synth) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.ws === ws) state.ws = null;
        try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.close(); } catch { /* noop */ }
        if (err) reject(err); else resolve(synth as Synth);
      };

      ws.onopen = () => {
        if (state.cancelled) { done(new Error('cancelled')); return; }
        // 연결 성사 → 연결 타이머를 합성 전체 타이머로 교체.
        clearTimeout(timer);
        timer = setTimeout(() => done(new Error('Edge TTS 합성 시간 초과')), SYNTH_TIMEOUT_MS);
        try { ws.send(speechConfigMessage()); ws.send(ssmlMessage(reqId, ssml)); }
        catch (e) { done(e instanceof Error ? e : new Error(String(e))); }
      };
      ws.onerror = () => done(new Error('Edge TTS WebSocket 오류'));
      ws.onclose = () => done(new Error('Edge TTS 연결이 조기 종료됨'));
      ws.onmessage = (ev: any) => {
        if (state.cancelled) { done(new Error('cancelled')); return; }
        const data = ev.data;
        if (typeof data === 'string') {
          const sep = data.indexOf('\r\n\r\n');
          if (sep < 0) return;
          const header = data.slice(0, sep);
          const body = data.slice(sep + 4);
          if (header.includes('Path:audio.metadata')) {
            try {
              const meta = JSON.parse(body);
              for (const m of meta.Metadata || []) {
                if (m.Type === 'WordBoundary' && m.Data) {
                  words.push({ text: String(m.Data.text?.Text ?? ''), offsetMs: (m.Data.Offset ?? 0) / TICKS_PER_MS });
                }
              }
            } catch { /* 메타 파싱 실패는 무시 */ }
          } else if (header.includes('Path:turn.end')) {
            // 정상 종료 확정. finalizeSynth(비동기 파일쓰기)가 도는 동안 서버가 소켓을 닫아도
            // onclose가 "조기 종료" 에러로 먼저 settle해 정상 결과를 버리는 race를 차단한다.
            ws.onclose = null;
            ws.onerror = null;
            this.finalizeSynth(text, audioChunks, words, state).then(
              (synth) => done(null, synth),
              (e) => done(e instanceof Error ? e : new Error(String(e))),
            );
          }
        } else {
          // 바이너리 프레임 파싱 — malformed 프레임이 핸들러 내부에서 uncaught 예외로 새지 않게 가드.
          try {
            const buf: ArrayBuffer = data;
            if (!buf || buf.byteLength < 2) return;
            const view = new DataView(buf);
            const headerLen = view.getUint16(0, false);
            if (2 + headerLen > buf.byteLength) return;
            const headerBytes = new Uint8Array(buf, 2, headerLen);
            let hs = '';
            for (let i = 0; i < headerBytes.length; i++) hs += String.fromCharCode(headerBytes[i]);
            if (!hs.includes('Path:audio')) return;
            const audio = new Uint8Array(buf, 2 + headerLen);
            if (audio.byteLength > 0) audioChunks.push(new Uint8Array(audio));
          } catch (e) {
            done(e instanceof Error ? e : new Error(String(e)));
          }
        }
      };
    });
  }

  private async finalizeSynth(
    text: string,
    audioChunks: Uint8Array[],
    words: Word[],
    state: SynthState,
  ): Promise<Synth> {
    const total = audioChunks.reduce((n, c) => n + c.byteLength, 0);
    if (total === 0) throw new Error('Edge TTS 오디오 수신 실패');
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of audioChunks) { merged.set(c, off); off += c.byteLength; }
    const dir = cacheDirectory || '';
    const uri = `${dir}edge-${connectId()}.mp3`;
    await writeAsStringAsync(uri, bytesToBase64(merged), { encoding: EncodingType.Base64 });
    if (state.cancelled) { deleteAsync(uri, { idempotent: true }).catch(() => { /* noop */ }); throw new Error('cancelled'); }
    state.uri = uri;
    return { uri, boundaries: this.mapBoundaries(text, words) };
  }

  private playFile(
    synth: Synth,
    params: SpeakParams,
    handlers: SpeakHandlers,
    myGen: number,
    preloaded?: AudioPlayer,
  ): void {
    try {
      this.currentUri = synth.uri;
      const boundaries = synth.boundaries;
      let bi = 0;

      // 프리로드된 플레이어가 있으면 그대로 재생(생성·prepare 생략 → 문장 시작 즉시).
      const player = preloaded ?? createAudioPlayer(synth.uri, { updateInterval: STATUS_UPDATE_MS });
      this.player = player;
      try { (player as any).shouldCorrectPitch = true; } catch { /* noop */ }
      // 배속은 항상 재적용(프리로드 시점과 설정이 달라졌을 수 있음 — 1 로 되돌리는 경우 포함).
      try { player.setPlaybackRate(edgePlaybackRate(params.rate)); } catch { /* noop */ }

      // 하이라이트 전진 — JS 타이머(포그라운드, 60ms)와 네이티브 상태 이벤트(PiP에서도 도착)
      // 양쪽에서 부른다. bi 단조 증가라 두 경로가 겹쳐도 중복 없음.
      const advance = (ms: number) => {
        while (bi < boundaries.length && boundaries[bi].ms <= ms) {
          handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen);
          bi++;
        }
      };

      this.statusSub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (myGen !== this.playGen || this.player !== player) return;
        if (st?.error) { this.teardownPlayback(); handlers.onError?.(new Error('Edge TTS 재생 오류')); return; }
        advance((st?.currentTime || 0) * 1000);
        if (st?.didJustFinish) {
          while (bi < boundaries.length) { handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen); bi++; }
          this.teardownPlayback();
          handlers.onDone?.();
        }
      });

      this.poll = setInterval(() => {
        if (myGen !== this.playGen || this.player !== player) return;
        advance((player.currentTime || 0) * 1000);
      }, 60);

      player.play();
    } catch (e) {
      // createAudioPlayer/리스너/play 실패 시 자원 정리 + 폴백 유도.
      this.teardownPlayback();
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export const edgeEngine = new EdgeTtsEngine();
