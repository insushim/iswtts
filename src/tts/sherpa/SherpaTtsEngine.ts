import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { cacheDirectory, deleteAsync } from 'expo-file-system/legacy';
import { createTTS, saveAudioToFile } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine as NativeTts } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine, SpeakParams, SpeakHandlers, EngineVoice } from '../TtsEngine';
import { sherpaModelPath } from '../../lib/sherpaModel';
import { sherpaModelSpeed, sherpaPlaybackRate, sherpaTrimEnabled } from './rate';
import { compressSilence } from './smartSpeed';

type Boundary = { ms: number; charIndex: number; charLen: number };
// trimFactor: 스마트 스피드(무음 압축)로 이미 번 배속(미압축=1) — 재생속도에서 이만큼 덜어낸다.
type Synth = { uri: string; boundaries: Boundary[]; trimFactor: number };
type SynthState = { cancelled: boolean; uri: string | null };
type CacheEntry = { promise: Promise<Synth>; cancel: () => void };

// 배속: 모델 speed 는 저속(≤1×)에만, 1× 초과는 전부 재생속도(피치보정) — 근거·CER 실측은 rate.ts.
// (v1.6.2 의 "전부 모델 speed" 방침은 Whisper CER 실측으로 폐기: 모델 2.0=CER72%, 3.0=82%
//  — "2배속부터 씹힘"의 근본원인. 재생속도 2.0=CER10% 로 온전. 과거 "setPlaybackRate 기기별
//  무음" 보고는 당시 모델 speed≥4 무음과 뒤섞인 미확정 귀속 — 재발 시 이 줄에 실측 기록할 것.)
const MAX_CACHE = 2;
// 합성 1건 상한(첫 호출의 모델 로드 포함). 네이티브 hang 시 직렬화 체인 전체가 영구
// 대기하는 것을 막는다 — 초과 시 이 건만 실패시키고(폴백 유도) 체인은 계속 흐른다.
const SYNTH_TIMEOUT_MS = 60_000;

// sherpa 빌드의 Supertonic 은 5개 언어만 지원(en/ko/es/pt/fr). lang 미지정 시 네이티브가
// 영어로 처리해 한국어 발음이 깨지므로(실측 2026-07-06) BCP-47 앞 2자를 매핑해 넘긴다.
// 지원 목록 밖(일본어·중국어 등)은 en 으로 폴백(그 언어 텍스트라도 최소한 재생은 됨).
const SUPERTONIC_LANGS = new Set(['en', 'ko', 'es', 'pt', 'fr']);
function langOf(language?: string): string {
  const code = (language || 'ko-KR').slice(0, 2).toLowerCase();
  return SUPERTONIC_LANGS.has(code) ? code : 'en';
}

// sherpa-onnx(Supertonic 3) 오프라인 신경망 엔진. 문장 하나 = 네이티브 합성 1회
// (단어 타임스탬프 포함) → WAV 파일 → expo-audio 재생 + 위치 폴링으로 onBoundary.
// 재생·prefetch·세대(playGen) 구조는 EdgeTtsEngine 과 동일 설계(검증된 패턴 재사용).
// 차이: 합성이 WebSocket 이 아니라 온디바이스 네이티브 호출이라 ① 취소는 결과 폐기로만
// 가능(중단 API 없음) ② 같은 인스턴스에 대한 동시 합성을 피하려고 체인으로 직렬화한다.
export class SherpaTtsEngine implements TtsEngine {
  readonly id = 'sherpa';
  readonly offline = true;

  private native: NativeTts | null = null;
  private initPromise: Promise<NativeTts> | null = null;
  // releaseNative 마다 증가 — 해제 도중 완료된 in-flight createTTS 가 삭제된 모델을 쥔
  // 인스턴스를 this.native 로 되살리는 것을 차단한다(세대 불일치 시 자체 destroy).
  private initGen = 0;
  private synthChain: Promise<unknown> = Promise.resolve();

  private playGen = 0;
  private player: AudioPlayer | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private statusSub: { remove: () => void } | null = null;
  private currentUri: string | null = null;
  private pendingSynth: CacheEntry | null = null;
  private cache = new Map<string, CacheEntry>();

  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void {
    const myGen = ++this.playGen;
    this.teardownPlayback();
    const key = this.keyOf(text, params);
    let entry = this.cache.get(key);
    if (entry) this.cache.delete(key); // 소비: 파일 소유권을 재생 쪽으로 이전
    else entry = this.makeSynth(text, params);
    this.pendingSynth = entry;

    entry.promise.then(
      (synth) => {
        if (this.pendingSynth === entry) this.pendingSynth = null;
        if (myGen !== this.playGen) {
          deleteAsync(synth.uri, { idempotent: true }).catch(() => { /* noop */ });
          return;
        }
        this.playFile(synth, params, handlers, myGen);
      },
      (err) => {
        if (this.pendingSynth === entry) this.pendingSynth = null;
        if (myGen !== this.playGen) return;
        if (String((err as Error)?.message) === 'cancelled') return;
        this.teardownPlayback();
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  prefetch(text: string, params: SpeakParams): void {
    if (!cacheDirectory) return;
    const key = this.keyOf(text, params);
    if (this.cache.has(key)) return;
    const entry = this.makeSynth(text, params);
    // 실패한 선행합성은 캐시에서 제거(다음 소비 시 재시도 기회 보존 + unhandled rejection 방지).
    entry.promise.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    this.cache.set(key, entry);
    this.evict();
  }

  stop(): void {
    this.playGen++;
    this.teardownPlayback();
    this.clearCache();
  }

  async getVoices(): Promise<EngineVoice[]> {
    // Supertonic 3 = 화자 10(sid 0~9). 라벨은 실청취로 고르게 안내(성별 메타데이터 없음).
    return Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      name: `화자 ${i + 1}`,
      language: '다국어',
      quality: 'neural',
    }));
  }

  // 모델 삭제 전 네이티브 인스턴스 해제(파일을 쥔 채 삭제하지 않도록).
  async releaseNative(): Promise<void> {
    this.stop();
    this.initGen++; // in-flight createTTS 는 세대 불일치로 자체 destroy 된다
    const pendingInit = this.initPromise;
    const n = this.native;
    this.native = null;
    this.initPromise = null;
    if (pendingInit) {
      try {
        await pendingInit;
      } catch {
        /* 초기화 실패/자체 취소 — 무관 */
      }
    }
    if (n) {
      // 진행 중이던 합성(취소 표시만 된 상태)이 체인에 남아 있을 수 있다 —
      // 같은 인스턴스에 대한 합성과 destroy 가 겹치지 않게 체인 종료를 기다린 뒤 파괴.
      try {
        await this.synthChain;
      } catch {
        /* 체인의 실패는 여기선 무관 — 종료만 확인 */
      }
      try {
        await n.destroy();
      } catch {
        /* noop */
      }
    }
  }

  // ── 초기화(지연·1회) ───────────────────────────────────
  private ensureNative(): Promise<NativeTts> {
    if (this.native) return Promise.resolve(this.native);
    if (this.initPromise) return this.initPromise;
    const myInitGen = this.initGen;
    this.initPromise = (async () => {
      const path = await sherpaModelPath();
      if (!path) throw new Error('오프라인 음성 모델이 설치되지 않았습니다.');
      const n = await createTTS({
        modelPath: { type: 'file', path },
        modelType: 'supertonic',
        numThreads: 2,
      });
      if (myInitGen !== this.initGen) {
        // 초기화 도중 releaseNative(모델 삭제 등)가 지나감 — 이 인스턴스를 되살리지 않는다.
        n.destroy().catch(() => { /* noop */ });
        throw new Error('cancelled');
      }
      this.native = n;
      return n;
    })();
    // 실패 시 다음 호출에서 재시도(모델을 방금 받았을 수도 있음).
    this.initPromise.catch(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  // ── 캐시/합성 ─────────────────────────────────────────
  // 캐시 키는 합성 파라미터만(재생속도는 재생 시 적용) — 1× 초과 배속끼리는 같은 합성을 재사용.
  private keyOf(text: string, params: SpeakParams): string {
    const sid = params.voiceId || '0';
    return `${sid}\u0000${sherpaModelSpeed(params.rate)}\u0000${langOf(params.language)}\u0000${text}`;
  }

  private makeSynth(text: string, params: SpeakParams): CacheEntry {
    const state: SynthState = { cancelled: false, uri: null };
    const cancel = () => {
      state.cancelled = true; // 네이티브 합성은 중단 불가 — 완료 시 결과만 폐기
      if (state.uri) {
        const u = state.uri;
        state.uri = null;
        deleteAsync(u, { idempotent: true }).catch(() => { /* noop */ });
      }
    };
    // 같은 네이티브 인스턴스에 합성이 겹치지 않게 직렬화(재생 자체는 파일이라 영향 없음).
    const promise = (this.synthChain = this.synthChain.then(
      () => this.synthesize(text, params, state),
      () => this.synthesize(text, params, state),
    )) as Promise<Synth>;
    return { promise, cancel };
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
    if (this.pendingSynth) {
      this.pendingSynth.cancel();
      this.pendingSynth = null;
    }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.statusSub) { try { this.statusSub.remove(); } catch { /* noop */ } this.statusSub = null; }
    if (this.player) { try { this.player.pause(); this.player.remove(); } catch { /* noop */ } this.player = null; }
    if (this.currentUri) {
      const u = this.currentUri;
      this.currentUri = null;
      deleteAsync(u, { idempotent: true }).catch(() => { /* noop */ });
    }
  }

  // 단어 타임스탬프(초 단위 start) → 문장 내 charIndex 매핑(EdgeTtsEngine 과 동일 로직).
  private mapBoundaries(text: string, words: { text: string; start: number }[]): Boundary[] {
    let cursor = 0;
    const out: Boundary[] = [];
    for (const w of words) {
      const t = w.text.trim();
      const ms = w.start * 1000;
      if (!t) { out.push({ ms, charIndex: cursor, charLen: 0 }); continue; }
      const idx = text.indexOf(t, cursor);
      if (idx >= 0) { cursor = idx + t.length; out.push({ ms, charIndex: idx, charLen: t.length }); }
      else out.push({ ms, charIndex: cursor, charLen: 0 });
    }
    return out;
  }

  // 타임아웃 래퍼 — 네이티브 hang 1건이 직렬화 체인을 영구히 막지 않게 한다.
  // 주의: 타임아웃 후에도 네이티브 호출 자체는 중단되지 않으므로(중단 API 없음) 다음 합성이
  // hang 난 호출과 겹칠 수 있다 — 영구 데드락보다 나은 차악이고, 서킷브레이커가 곧 폴백시킨다.
  private async synthesize(text: string, params: SpeakParams, state: SynthState): Promise<Synth> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        state.cancelled = true; // 뒤늦게 완료돼도 결과(파일) 폐기
        reject(new Error('오프라인 음성 합성 시간 초과'));
      }, SYNTH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.doSynthesize(text, params, state), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async doSynthesize(text: string, params: SpeakParams, state: SynthState): Promise<Synth> {
    if (state.cancelled) throw new Error('cancelled');
    const native = await this.ensureNative();
    if (state.cancelled) throw new Error('cancelled');

    const audio = await native.generateSpeechWithTimestamps(text, {
      sid: Number.parseInt(params.voiceId || '0', 10) || 0,
      speed: sherpaModelSpeed(params.rate),
      // extra.lang 은 patches/react-native-sherpa-onnx+0.4.3.patch 로 네이티브까지 배선됨
      // (원본은 이 값을 버려 Supertonic 이 한국어를 영어 발음으로 읽었다 — 실측 2026-07-06).
      extra: { lang: langOf(params.language) },
      subtitles: { mode: 'fast', granularity: 'word' },
    });
    if (state.cancelled) throw new Error('cancelled');
    if (!audio.samples?.length) throw new Error('오프라인 음성 합성 실패(빈 오디오)');

    // 스마트 스피드: 초고배속(>3×)만 긴 쉼을 압축해 스트레치 부담을 덜어낸다(smartSpeed.ts).
    // 단어 하이라이트 타임스탬프도 같은 매핑으로 보정.
    let samples: number[] = audio.samples;
    let trimFactor = 1;
    let boundaries = this.mapBoundaries(text, audio.subtitles || []);
    if (sherpaTrimEnabled(params.rate)) {
      const c = compressSilence(audio.samples, audio.sampleRate);
      samples = c.samples;
      trimFactor = c.factor;
      boundaries = boundaries.map((b) => ({ ...b, ms: c.mapMs(b.ms) }));
    }
    if (state.cancelled) throw new Error('cancelled');

    // 네이티브 WAV 저장은 file:// 없는 절대경로, expo-audio 재생은 file:// URI.
    const dir = (cacheDirectory || '').replace(/^file:\/\//, '');
    if (!dir) throw new Error('캐시 디렉토리 없음');
    const name = `sherpa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`;
    const plainPath = `${dir}${name}`;
    await saveAudioToFile({ samples, sampleRate: audio.sampleRate }, plainPath);
    const uri = `file://${plainPath}`;
    if (state.cancelled) {
      deleteAsync(uri, { idempotent: true }).catch(() => { /* noop */ });
      throw new Error('cancelled');
    }
    state.uri = uri;
    return { uri, boundaries, trimFactor };
  }

  private playFile(synth: Synth, params: SpeakParams, handlers: SpeakHandlers, myGen: number): void {
    try {
      this.currentUri = synth.uri;
      const boundaries = synth.boundaries;
      let bi = 0;

      const player = createAudioPlayer(synth.uri);
      this.player = player;
      // 1× 초과 배속은 여기(피치보정 재생속도)가 담당 — 합성은 자연속도(rate.ts 근거).
      // 3.0 까지 허용은 patches/expo-audio(coerceIn 상한 해제) 필요.
      // 무음 압축으로 이미 번 몫(trimFactor)만큼 스트레치를 덜어낸다(초고배속 또렷함 개선).
      try { (player as any).shouldCorrectPitch = true; } catch { /* noop */ }
      const pr = sherpaPlaybackRate(params.rate, synth.trimFactor);
      if (pr !== 1) { try { player.setPlaybackRate(pr); } catch { /* noop */ } }
      this.statusSub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (myGen !== this.playGen || this.player !== player) return;
        if (st?.error) { this.teardownPlayback(); handlers.onError?.(new Error('오프라인 음성 재생 오류')); return; }
        if (st?.didJustFinish) {
          while (bi < boundaries.length) { handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen); bi++; }
          this.teardownPlayback();
          handlers.onDone?.();
        }
      });

      this.poll = setInterval(() => {
        if (myGen !== this.playGen || this.player !== player) return;
        const ms = (player.currentTime || 0) * 1000;
        while (bi < boundaries.length && boundaries[bi].ms <= ms) {
          handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen);
          bi++;
        }
      }, 60);

      player.play();
    } catch (e) {
      this.teardownPlayback();
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export const sherpaEngine = new SherpaTtsEngine();
