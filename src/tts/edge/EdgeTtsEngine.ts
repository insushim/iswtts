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
import { EDGE_VOICES, defaultEdgeVoice } from './voices';

type Word = { text: string; offsetMs: number };
type Boundary = { ms: number; charIndex: number; charLen: number };

const CONNECT_TIMEOUT_MS = 8000;

// Edge(Read Aloud) 온라인 신경망 엔진. 문장 하나 = WebSocket 요청 하나(오디오+단어타이밍) →
// 파일로 받아 expo-audio 로 재생, 재생위치를 폴링해 기존 onBoundary 콜백으로 단어 하이라이트.
// TtsEngine 인터페이스를 그대로 지켜 플레이어/UI 변경 없이 스왑된다.
//
// 세대(gen) 토큰: speak()/stop() 마다 gen 을 올려, 지연된 비동기 연속(토큰생성·파일쓰기 후 재개)이
// 자기 세대가 아니면 즉시 중단하게 한다. 단일 boolean(aborted)로는 speak()가 곧바로 false 로
// 되돌려 stale run 이 되살아나 이전 문장 오디오가 재생되는 경쟁을 막을 수 없다(7way 지적 반영).
export class EdgeTtsEngine implements TtsEngine {
  readonly id = 'edge';
  readonly offline = false;

  private gen = 0;
  private ws: WebSocket | null = null;
  private player: AudioPlayer | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private statusSub: { remove: () => void } | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentUri: string | null = null;

  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void {
    const myGen = ++this.gen; // 이전 세대 무효화
    this.teardown();
    this.run(text, params, handlers, myGen).catch((e) => {
      if (myGen !== this.gen) return;
      this.teardown();
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
  }

  stop(): void {
    this.gen++; // 진행 중 세대 무효화
    this.teardown();
  }

  async getVoices(): Promise<EngineVoice[]> {
    return EDGE_VOICES;
  }

  // ── 내부 ──────────────────────────────────────────────

  private teardown(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.statusSub) { try { this.statusSub.remove(); } catch { /* noop */ } this.statusSub = null; }
    if (this.player) { try { this.player.pause(); this.player.remove(); } catch { /* noop */ } this.player = null; }
    if (this.ws) {
      try { this.ws.onopen = null; this.ws.onmessage = null; this.ws.onerror = null; this.ws.onclose = null; this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    // 재생 끝난/버려진 임시 mp3 삭제(디스크 누수 방지).
    if (this.currentUri) {
      const u = this.currentUri;
      this.currentUri = null;
      deleteAsync(u, { idempotent: true }).catch(() => { /* noop */ });
    }
  }

  private ratePct(rate?: number): string {
    const r = rate ?? 1.0;
    // Edge 는 프로소디 rate 로 피치 보존 배속. 서비스 오류 방지 위해 -90%~+300% 로 클램프.
    const pct = Math.max(-90, Math.min(300, Math.round((r - 1) * 100)));
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  }

  // 서버가 준 단어 텍스트를 원문 문장에서 순차 매칭해 charIndex 를 복원(근사).
  private mapBoundaries(text: string, words: Word[]): Boundary[] {
    let cursor = 0;
    const out: Boundary[] = [];
    for (const w of words) {
      const t = unescapeXml(w.text);
      if (!t) { out.push({ ms: w.offsetMs, charIndex: cursor, charLen: 0 }); continue; }
      const idx = text.indexOf(t, cursor);
      if (idx >= 0) {
        cursor = idx + t.length;
        out.push({ ms: w.offsetMs, charIndex: idx, charLen: t.length });
      } else {
        // 매칭 실패(숫자 확장·기호 등) → 이전 위치 유지, 하이라이트만 이어감.
        out.push({ ms: w.offsetMs, charIndex: cursor, charLen: 0 });
      }
    }
    return out;
  }

  private async run(
    text: string,
    params: SpeakParams,
    handlers: SpeakHandlers,
    myGen: number,
  ): Promise<void> {
    const voice = params.voiceId || defaultEdgeVoice(params.language);
    // 문장은 상위 segment.ts 에서 ≤280자로 분할돼 오므로 단일 SSML 요청으로 안전(정본의 4096 청킹 불필요).
    const ssml = buildSsml(text, voice, params.language || 'ko-KR', this.ratePct(params.rate));
    const reqId = connectId();
    const token = await generateSecMsGec();
    if (myGen !== this.gen) return;

    const url =
      `${WSS_URL}&ConnectionId=${connectId()}` +
      `&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    // RN WebSocket: 3번째 인자로 커스텀 헤더 지정(네이티브 구현이라 가능하나 lib 타입엔 없어 캐스팅).
    const headers = { ...WSS_HEADERS, Cookie: muidCookie() };
    const ws = new (WebSocket as any)(url, undefined, { headers }) as WebSocket;
    (ws as any).binaryType = 'arraybuffer';
    this.ws = ws;

    const audioChunks: Uint8Array[] = [];
    const words: Word[] = [];
    let finished = false;

    const fail = (msg: string) => {
      if (myGen !== this.gen || finished) return;
      finished = true;
      this.teardown();
      handlers.onError?.(new Error(msg));
    };

    this.connectTimer = setTimeout(() => fail('Edge TTS 연결 시간 초과'), CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (myGen !== this.gen) return;
      try {
        ws.send(speechConfigMessage());
        ws.send(ssmlMessage(reqId, ssml));
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    };

    ws.onerror = () => fail('Edge TTS WebSocket 오류');
    ws.onclose = () => fail('Edge TTS 연결이 조기 종료됨'); // turn.end 없이 닫힘 = 실패

    ws.onmessage = (ev: any) => {
      if (myGen !== this.gen) return;
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
                words.push({
                  text: String(m.Data.text?.Text ?? ''),
                  offsetMs: (m.Data.Offset ?? 0) / TICKS_PER_MS,
                });
              }
            }
          } catch { /* 메타 파싱 실패는 무시(하이라이트만 손실) */ }
        } else if (header.includes('Path:turn.end')) {
          if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
          finished = true;
          this.onTurnEnd(text, audioChunks, words, handlers, myGen).catch((e) => {
            if (myGen !== this.gen) return;
            this.teardown();
            handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
          });
        }
      } else {
        // 바이너리: [2바이트 빅엔디안 헤더길이][헤더][오디오]
        const buf: ArrayBuffer = data;
        if (!buf || buf.byteLength < 2) return;
        const view = new DataView(buf);
        const headerLen = view.getUint16(0, false);
        if (2 + headerLen > buf.byteLength) return;
        const headerBytes = new Uint8Array(buf, 2, headerLen);
        let hs = '';
        for (let i = 0; i < headerBytes.length; i++) hs += String.fromCharCode(headerBytes[i]);
        if (!hs.includes('Path:audio')) return; // audio 프레임만 취급
        const audio = new Uint8Array(buf, 2 + headerLen);
        if (audio.byteLength > 0) audioChunks.push(new Uint8Array(audio)); // 복사(버퍼 재사용 방지)
      }
    };
  }

  private async onTurnEnd(
    text: string,
    audioChunks: Uint8Array[],
    words: Word[],
    handlers: SpeakHandlers,
    myGen: number,
  ): Promise<void> {
    // ws 는 더 필요 없음.
    if (this.ws) {
      try { this.ws.onmessage = null; this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    const total = audioChunks.reduce((n, c) => n + c.byteLength, 0);
    if (total === 0) { handlers.onError?.(new Error('Edge TTS 오디오 수신 실패')); return; }

    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of audioChunks) { merged.set(c, off); off += c.byteLength; }

    const dir = cacheDirectory || '';
    const uri = `${dir}edge-${connectId()}.mp3`;
    await writeAsStringAsync(uri, bytesToBase64(merged), { encoding: EncodingType.Base64 });
    if (myGen !== this.gen) {
      // 이 세대가 이미 폐기됨 → 방금 쓴 파일도 정리하고 종료.
      deleteAsync(uri, { idempotent: true }).catch(() => { /* noop */ });
      return;
    }
    this.currentUri = uri; // teardown 시 삭제 대상

    const boundaries = this.mapBoundaries(text, words);
    let bi = 0;

    const player = createAudioPlayer(uri);
    this.player = player;

    this.statusSub = player.addListener('playbackStatusUpdate', (st: any) => {
      if (myGen !== this.gen || this.player !== player) return;
      if (st?.error) { this.teardown(); handlers.onError?.(new Error('Edge TTS 재생 오류')); return; }
      if (st?.didJustFinish) {
        while (bi < boundaries.length) { handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen); bi++; }
        this.teardown();
        handlers.onDone?.();
      }
    });

    this.poll = setInterval(() => {
      if (myGen !== this.gen || this.player !== player) return;
      const ms = (player.currentTime || 0) * 1000;
      while (bi < boundaries.length && boundaries[bi].ms <= ms) {
        handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen);
        bi++;
      }
    }, 60);

    player.play();
  }
}

export const edgeEngine = new EdgeTtsEngine();
