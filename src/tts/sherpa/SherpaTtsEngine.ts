import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { cacheDirectory, deleteAsync } from 'expo-file-system/legacy';
import { createTTS, saveAudioToFile } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine as NativeTts } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine, SpeakParams, SpeakHandlers, EngineVoice } from '../TtsEngine';
import { sherpaModelPath } from '../../lib/sherpaModel';
import { sherpaModelSpeed, sherpaPlaybackRate, sherpaTrimEnabled } from './rate';
import { disposePlayer } from '../disposePlayer';
import { compressSilence, trimEdgeSilence } from './smartSpeed';
import { estimateWordBoundaries, type WordBoundary } from './align';
import { recordSynth, recordStarvation, recordPlaybackProgress } from './stats';
import { subtitlesVisible, onVisibilityChange } from '../../lib/visibility';

// trimFactor: 스마트 스피드(무음 압축)로 이미 번 배속(미압축=1) — 재생속도에서 이만큼 덜어낸다.
type Synth = { uri: string; boundaries: WordBoundary[]; trimFactor: number };
type SynthState = { cancelled: boolean; uri: string | null };
// player: 합성 완료 시 미리 생성·prepare·배속 적용해 둔 재생기(프리로드) — 문장 전환이 play()
// 한 번으로 끝나 시작 지연이 사라진다. disposed: cancel 이후 뒤늦은 프리로드 생성 차단.
type CacheEntry = {
  promise: Promise<Synth>;
  cancel: () => void;
  player?: AudioPlayer;
  disposed?: boolean;
  // 합성 결과(완료 시). 프리로드 슬롯이 나중에 비었을 때 재시도하려면 결과를 들고 있어야 한다.
  synth?: Synth;
  // 프리로드 플레이어 생성(멱등 — 이미 있거나 상한이면 no-op). prefetch 가 채운다.
  preload?: (synth: Synth) => void;
};

// 프리로드된(아직 재생 전) 플레이어 해제 — 여러 경합 지점에서 부르므로 멱등.
function releasePreload(entry: CacheEntry): void {
  const p = entry.player;
  if (!p) return;
  entry.player = undefined;
  disposePlayer(p);
}

// 배속: 모델 speed 는 저속(≤1×)에만, 1× 초과는 전부 재생속도(피치보정) — 근거·CER 실측은 rate.ts.
// (v1.6.2 의 "전부 모델 speed" 방침은 Whisper CER 실측으로 폐기: 모델 2.0=CER72%, 3.0=82%
//  — "2배속부터 씹힘"의 근본원인. 재생속도 2.0=CER10% 로 온전. 과거 "setPlaybackRate 기기별
//  무음" 보고는 당시 모델 speed≥4 무음과 뒤섞인 미확정 귀속 — 재발 시 이 줄에 실측 기록할 것.)
// 선행 합성 버퍼 깊이(파일). 선행 20(prefetchUnits)보다 크게 잡아 재생 중 유닛 + 선행분이
// 캐시에서 서로를 밀어내지 않게 한다(여유 4 = 경합·타이밍 대비. 선행 개수는 player.ts 가
// depth 로 항상 상한하므로 대사 세그먼트가 많아도 20을 넘지 않는다).
// 왜 이렇게 깊은가(2026-07-13 실측 + 2026-07-15 사용자 선택): 합성 RTF 는 맥 M-series 에서
// 0.11~0.34, 안드로이드 중급기면 그 5~10배 → 1.5× 재생 예산(RTF<0.67)에 아슬아슬하게 걸친다.
// 문장 길이 편차·CPU 스파이크가 겹치는 순간 캐시가 말라 발화 시작이 밀리고, 그 밀림의 편차가
// "속도가 왔다 갔다"였다. 버퍼를 깊게(20) 두면 짧은 문장에서 합성이 앞서 벌어둔 여유로 가끔
// 오는 무거운 문장을 덮어 지터를 흡수한다. 폰이 *평균적으로* 예산 안이면 이걸로 평탄해지고,
// *평균적으로도* 못 따라가면 버퍼로는 못 고친다(그땐 진단이 "준비 속도"로 알려줌).
// (합성은 체인 직렬이라 동시 CPU 부하는 그대로 1건씩 — 큐만 깊어진다.)
// 메모리: 파일은 디스크 캐시(메모리 아님) — 44.1kHz WAV ≈ 1MB/5초 × 24 ≈ 24MB(cacheSweep 정리).
const MAX_CACHE = 24;
// 미리 만들어 두는 AudioPlayer 수 상한. 파일 캐시(8)와 달리 플레이어는 네이티브 자원이라
// 다음 발화 몫만 준비해 둔다(문장 시작 즉시 재생 효과는 1~2개로 이미 다 얻는다).
const MAX_PRELOAD = 2;
// 네이티브 상태 이벤트 주기(ms). PiP에선 JS 타이머가 얼어붙어 이 이벤트만이 자막을 움직인다.
const STATUS_UPDATE_MS = 80;
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
  // 오프라인은 CPU 가 재생을 아슬아슬하게 따라가므로 깊게 미리 만든다(MAX_CACHE 보다 작게).
  readonly prefetchUnits = 20;

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
  // 화면 켜짐/꺼짐 구독 해제자 — teardown 에서 반드시 끊는다(안 끊으면 죽은 플레이어의
  // 폴링을 되살리려 하고, 발화마다 구독이 쌓인다).
  private visSub: (() => void) | null = null;
  private currentUri: string | null = null;
  private pendingSynth: CacheEntry | null = null;
  private cache = new Map<string, CacheEntry>();
  // 현재 재생 중 오디오의 합성 파라미터 — setRate 라이브 적용 가능 판정용.
  private currentModelSpeed: number | null = null;
  private currentTrimEnabled: boolean | null = null;
  private currentTrimFactor = 1;

  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void {
    const myGen = ++this.playGen;
    this.teardownPlayback();
    const key = this.keyOf(text, params);
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key); // 소비: 파일 소유권을 재생 쪽으로 이전(선행합성 히트 = 부드러운 자동진행)
    } else {
      // 캐시 미스 = 지금 당장 들려줄 이 문장이 아직 안 만들어졌다. 합성 체인은 같은 네이티브
      // 인스턴스라 1건씩 직렬이고 FIFO 라, 큐에 이미 쌓인 선행합성(미래 문장)이 이 문장보다 앞서
      // 있으면 재생이 그 뒤에서 수십 초~수 분을 기다린다 = "배속 바꾸면 멈춤"의 진짜 원인(실측
      // 2026-07-16: 재생 중 −/+ 로 배속을 빠르게 오르내리면 재발화가 겹치며 선행합성이 현재 문장
      // 앞을 막아 ~80s+ 정지). 그래서 지금 큐에 있는 선행합성을 전부 취소하고(취소분은 doSynthesize
      // 진입 즉시 throw 되어 체인이 곧장 다음으로 넘어감) 이 문장을 최우선으로 만든다. 미래분은 아래
      // prefetch 루프가 곧바로 다시 채운다. 정상 자동진행은 항상 캐시 히트라 이 경로를 타지 않는다.
      this.clearCache();
      entry = this.makeSynth(text, params);
    }
    this.pendingSynth = entry;
    // 발화 시작까지 실제로 기다린 시간 = 파이프라인이 말랐는지의 직접 증거(stats.ts).
    // 캐시 히트(합성 완료분)면 0 에 수렴하고, 마르면 그 대기가 곧 낭독 리듬의 흔들림이다.
    const askedAt = Date.now();

    entry.promise.then(
      (synth) => {
        if (this.pendingSynth === entry) this.pendingSynth = null;
        if (myGen === this.playGen) recordStarvation(Date.now() - askedAt, Date.now());
        if (myGen !== this.playGen) {
          releasePreload(entry);
          deleteAsync(synth.uri, { idempotent: true }).catch(() => { /* noop */ });
          return;
        }
        const preloaded = entry.player;
        entry.player = undefined; // 소유권을 재생 쪽으로 이전(이후 cancel이 건드리지 않게)
        this.playFile(synth, params, handlers, myGen, preloaded);
        // 방금 슬롯이 하나 비었다 — 상한에 걸려 못 만든 다음 발화의 플레이어를 지금 만든다.
        this.topUpPreload();
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
    // 이미 있는 항목은 재합성하지 않되, "방금 다시 요청됐다"는 사실로 축출 우선순위를 되살린다
    // (Map 재삽입 = 최신 순서). 안 하면 뒤로 seek 했을 때 FIFO 가 정작 바로 다음에 재생될
    // 문장을 먼저 취소해, 온디맨드 재합성 + 발화 대기가 되살아난다(교차검증 지적 2026-07-13).
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return;
    }
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
    // 실패한 선행합성은 캐시에서 제거(다음 소비 시 재시도 기회 보존 + unhandled rejection 방지).
    entry.promise.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    // 프리로드: 합성이 끝나는 즉시 플레이어 생성(+prepare)·배속 적용까지 마쳐 둔다.
    // 문장 전환 때 하던 이 작업(수십~수백 ms)이 문장 시작의 "머뭇거림"이었다(2026-07-08).
    // 이 .then은 speak의 소비 .then보다 먼저 등록돼 항상 먼저 실행된다(등록 순서 보장).
    //
    // 플레이어는 네이티브 자원이라 앞쪽 MAX_PRELOAD 건만 만든다(파일 버퍼는 깊게, 플레이어는
    // 얕게). 상한에 걸려 못 만든 엔트리는 재생이 앞 문장을 소비해 슬롯이 비는 즉시
    // topUpPreload()가 다시 시도한다 — 없으면 3번째 이후 문장은 캐시에 파일이 있어도 재생
    // 시점에 createAudioPlayer 를 동기로 만들어야 해서 버퍼를 깊게 잡은 효과가 반감된다
    // (교차검증 지적 2026-07-13).
    entry.preload = (synth: Synth) => {
      if (entry.disposed || entry.player) return;
      if (this.preloadedCount() >= MAX_PRELOAD) return;
      try {
        const p = createAudioPlayer(synth.uri, { updateInterval: STATUS_UPDATE_MS });
        try { (p as any).shouldCorrectPitch = true; } catch { /* noop */ }
        try { p.setPlaybackRate(sherpaPlaybackRate(params.rate, synth.trimFactor)); } catch { /* noop */ }
        // 이 함수는 전부 동기라 disposed 체크(위)와 대입 사이에 cancel이 끼어들 수 없다.
        entry.player = p;
      } catch { /* 프리로드 실패는 무해 — 재생 시점에 새로 만든다 */ }
    };
    entry.promise
      .then((synth) => {
        entry.synth = synth; // 나중(슬롯이 빌 때)의 재시도용
        entry.preload?.(synth);
      })
      .catch(() => { /* 합성 실패는 위 catch가 처리 */ });
    this.cache.set(key, entry);
    this.evict();
  }

  // 프리로드 슬롯이 빈 만큼(재생이 앞 문장을 소비) 캐시 앞쪽부터 플레이어를 채운다.
  // 합성이 끝나 있는 엔트리만 대상 — 아직 합성 중이면 그 엔트리의 .then 이 알아서 만든다.
  private topUpPreload(): void {
    if (this.preloadedCount() >= MAX_PRELOAD) return;
    for (const e of this.cache.values()) {
      if (this.preloadedCount() >= MAX_PRELOAD) return;
      if (!e.player && e.synth && !e.disposed) e.preload?.(e.synth);
    }
  }

  stop(): void {
    this.playGen++;
    this.teardownPlayback();
    this.clearCache();
  }

  // 재생 중 배속 라이브 변경. 합성은 자연속도 고정이라(≤3×: 모델 speed=1·무음압축 off)
  // 그 구간 안에서는 스트레치만 바꿔 끼우면 된다 — 재합성·끊김 0. 합성 파라미터가 달라지는
  // 경계(1× 이하·3× 초과)를 넘나들면 false — 호출부가 재발화로 폴백.
  setRate(rate: number): boolean {
    if (!this.player || this.currentModelSpeed === null) return false;
    if (this.currentModelSpeed !== sherpaModelSpeed(rate)) return false;
    if (this.currentTrimEnabled !== sherpaTrimEnabled(rate)) return false;
    try {
      this.player.setPlaybackRate(sherpaPlaybackRate(rate, this.currentTrimFactor));
      return true;
    } catch {
      return false;
    }
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
      // numThreads=2 가 최적(맥 M-series 실측 2026-07-13, 같은 5문장 합성 RTF):
      //   1스레드 0.192 / 2스레드 0.108 / 4스레드 0.113 / 6스레드 0.147
      // 2 를 넘기면 스레드 동기화 비용이 이득을 먹는다 — 늘려도 합성이 빨라지지 않으므로
      // "느리니 스레드를 더 주자"는 유혹을 여기서 차단한다(코어만 더 뺏겨 재생이 손해).
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

  private preloadedCount(): number {
    let n = 0;
    for (const e of this.cache.values()) if (e.player) n++;
    return n;
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
    if (this.visSub) { try { this.visSub(); } catch { /* noop */ } this.visSub = null; }
    if (this.statusSub) { try { this.statusSub.remove(); } catch { /* noop */ } this.statusSub = null; }
    if (this.player) { const p = this.player; this.player = null; disposePlayer(p); }
    this.currentModelSpeed = null;
    this.currentTrimEnabled = null;
    this.currentTrimFactor = 1;
    if (this.currentUri) {
      const u = this.currentUri;
      this.currentUri = null;
      deleteAsync(u, { idempotent: true }).catch(() => { /* noop */ });
    }
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
    // 모델 로드(첫 1회)는 합성 비용이 아니므로 계측 시작은 여기부터.
    const synthStart = Date.now();

    // ⚠️ generateSpeech 로 바꾸지 말 것: 그 경로의 일반 모델 분기는 네이티브에서
    // dispatchGenerate(text, sid, speed)로 options(extra.lang)를 통째로 버린다(소스 실측
    // 2026-07-07) — 한국어가 영어 발음으로 깨지는 v1.6.2 버그 재발. lang 배선 패치
    // (patches/react-native-sherpa-onnx+0.4.3.patch)는 이 타임스탬프 경로에만 걸려 있다.
    const audio = await native.generateSpeechWithTimestamps(text, {
      sid: Number.parseInt(params.voiceId || '0', 10) || 0,
      speed: sherpaModelSpeed(params.rate),
      extra: { lang: langOf(params.language) },
      // 자막 결과는 버린다(sentence 단위 = 최소 비용) — fast 모드는 앞뒤 무음·쉼을 발화로
      // 깔고 계산한 글자수 비례 추정이라 하이라이트가 수백 ms 어긋났다(Whisper 대조 실측
      // 2026-07-07). 단어 타임스탬프는 아래 자체 정렬(align.ts)로 계산한다.
      subtitles: { mode: 'fast', granularity: 'sentence' },
    });
    if (state.cancelled) throw new Error('cancelled');
    if (!audio.samples?.length) throw new Error('오프라인 음성 합성 실패(빈 오디오)');

    // 원본 44.1kHz 그대로 사용. v1.17 의 22.05kHz 다운샘플은 폐기(2026-07-15) — 값싼 3탭
    // 저역통과가 나이퀴스트(11kHz) 근처 앨리어싱을 통과시켜 "지직거림 + 발음 뭉개짐"을 냈다
    // (제대로 된 폴리페이즈 리샘플이면 그 대역을 −2.7dB 깎지만 3탭은 +0.2dB 로 흘려보냄, 왜곡
    // −30dB — 사용자 보고 + scipy 대조 실측). Whisper CER 은 0% 였지만 그건 "알아들린다"일 뿐
    // "좋게 들린다"가 아니었다(자기함정). 배터리 이득도 codex 판정상 제한적(진짜 소비원은 80ms
    // 네이티브 이벤트)이라, 확실한 음질 손상과 맞바꿀 가치가 없었다. 검증된 원본으로 복귀.
    const rawSamples: ArrayLike<number> = audio.samples;
    const sampleRate = audio.sampleRate;

    // 무음 처리(smartSpeed.ts):
    // - ≤3×: 앞뒤 무음만 트림(말소리·내부 쉼 불변, 속도 보상 없음) — Supertonic 이 문장마다
    //   박는 앞 ~0.4s·뒤 ~0.5s 죽은 공기가 "문장 전환 텀"의 주범(실측 2026-07-07).
    // - >3×(스마트 스피드): 내부 긴 쉼까지 압축하고 그만큼 재생 스트레치를 덜어낸다.
    let samples: number[];
    let trimFactor = 1;
    if (sherpaTrimEnabled(params.rate)) {
      const c = compressSilence(rawSamples, sampleRate);
      samples = c.samples;
      trimFactor = c.factor;
    } else {
      samples = trimEdgeSilence(rawSamples, sampleRate);
    }
    // 단어 하이라이트: 최종(트림 후) 샘플에서 발화 구간 위에만 글자수 비례 분배 — 쉼 동안
    // 하이라이트가 전진하지 않고, 무음 오프셋 오차가 원천 제거된다.
    const boundaries = estimateWordBoundaries(text, samples, sampleRate);
    if (state.cancelled) throw new Error('cancelled');

    // 네이티브 WAV 저장은 file:// 없는 절대경로, expo-audio 재생은 file:// URI.
    const dir = (cacheDirectory || '').replace(/^file:\/\//, '');
    if (!dir) throw new Error('캐시 디렉토리 없음');
    const name = `sherpa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`;
    const plainPath = `${dir}${name}`;
    // ⚠️ 샘플과 sampleRate 는 항상 짝을 맞춰 저장할 것. 데이터 길이와 헤더 레이트가 어긋나면
    // 배속·피치가 통째로 틀어진다("칩멍크" 사고 2026-07-14). 지금은 원본 그대로라 audio 값 사용.
    await saveAudioToFile({ samples, sampleRate }, plainPath);
    const uri = `file://${plainPath}`;
    if (state.cancelled) {
      deleteAsync(uri, { idempotent: true }).catch(() => { /* noop */ });
      throw new Error('cancelled');
    }
    state.uri = uri;
    // RTF = 발화 1건을 "재생 가능한 상태"로 만드는 데 든 시간 ÷ 그 파일이 실제로 재생될 길이.
    // ⚠️ 분자는 네이티브 합성만이 아니라 무음 트림·단어 정렬·WAV 저장(25만 float 을 브릿지로
    // 넘기는 동기 마샬링)까지 포함한다 — 파이프라인이 마르는지를 결정하는 건 이 전체 비용이다.
    // ⚠️ 분모는 반드시 "트림 후" 길이(= 실제 재생 시간)여야 한다. 트림 전 원본 길이를 쓰면
    //    문장마다 앞뒤 무음(~0.9s)만큼 분모가 부풀어 RTF 가 낙관적으로 기록되고, 못 따라가는
    //    기기를 정상으로 오판한다(교차검증 지적 2026-07-13 — 계측을 저장 뒤로 옮기며 유입됨).
    // 불변식: rtf × 설정배속 ≥ 1 이면 재생이 준비를 앞질러 캐시가 마른다.
    recordSynth(Date.now() - synthStart, (samples.length / sampleRate) * 1000);
    return { uri, boundaries, trimFactor };
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
      this.currentModelSpeed = sherpaModelSpeed(params.rate);
      this.currentTrimEnabled = sherpaTrimEnabled(params.rate);
      this.currentTrimFactor = synth.trimFactor;
      const boundaries = synth.boundaries;
      let bi = 0;

      // 프리로드된 플레이어가 있으면 그대로 재생(생성·prepare 생략 → 문장 시작 즉시).
      const player = preloaded ?? createAudioPlayer(synth.uri, { updateInterval: STATUS_UPDATE_MS });
      this.player = player;
      // 1× 초과 배속은 여기(피치보정 재생속도)가 담당 — 합성은 자연속도(rate.ts 근거).
      // 3.0 까지 허용은 patches/expo-audio(coerceIn 상한 해제) 필요.
      // 무음 압축으로 이미 번 몫(trimFactor)만큼 스트레치를 덜어낸다(초고배속 또렷함 개선).
      try { (player as any).shouldCorrectPitch = true; } catch { /* noop */ }
      // 배속은 항상 재적용(캐시 키가 재생속도를 안 품어 프리로드 시점과 다를 수 있음 —
      // 1 로 되돌리는 경우 포함).
      try { player.setPlaybackRate(sherpaPlaybackRate(params.rate, synth.trimFactor)); } catch { /* noop */ }

      // 하이라이트 전진 — JS 타이머(포그라운드, 60ms)와 네이티브 상태 이벤트(PiP에서도 도착)
      // 양쪽에서 부른다. bi 단조 증가라 두 경로가 겹쳐도 중복 없음.
      //
      // 화면이 꺼져 있으면(자막을 볼 사람이 없으면) 커서만 조용히 전진시키고 onBoundary 는
      // 부르지 않는다 — 그 호출 하나하나가 zustand set → React 리렌더라 배터리를 태운다.
      // bi 는 계속 밀어 두므로 화면이 켜지는 순간 이미 맞는 위치에서 하이라이트가 재개된다
      // (2026-07-14 사용자 보고 "배터리를 엄청 먹네").
      const advance = (ms: number) => {
        const notify = subtitlesVisible();
        while (bi < boundaries.length && boundaries[bi].ms <= ms) {
          if (notify) handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen);
          bi++;
        }
      };

      // 화면 복귀 시 하이라이트를 "지금 읽고 있는 단어"로 즉시 되돌린다.
      // ⚠️ advance() 만으로는 안 된다: 화면이 꺼진 동안에도 커서(bi)는 계속 전진했으므로
      // 복귀 시점엔 이미 현재 위치를 통과해 있어 while 조건이 거짓 → onBoundary 가 한 번도
      // 안 불리고, 하이라이트가 화면 꺼지던 순간의 단어에 멈춘 채 다음 단어까지 방치된다
      // (교차검증 발견 2026-07-14). 마지막으로 통과한 경계를 강제로 다시 통지한다.
      const resync = () => {
        if (bi > 0 && bi <= boundaries.length) {
          const b = boundaries[bi - 1];
          handlers.onBoundary?.(b.charIndex, b.charLen);
        }
      };

      // 60ms 폴링은 자막이 보일 때만 돈다. 화면이 꺼지면 타이머를 아예 없애 CPU 를 깨우지
      // 않는다(초당 16.7회 JS 깨움 → 0). 오디오·문장 진행은 네이티브 상태 이벤트가 계속 몰고
      // 가므로 낭독은 그대로 이어진다.
      const startPoll = () => {
        if (this.poll) return;
        this.poll = setInterval(() => {
          if (myGen !== this.playGen || this.player !== player) return;
          advance((player.currentTime || 0) * 1000);
        }, 60);
      };
      const stopPoll = () => {
        if (!this.poll) return;
        clearInterval(this.poll);
        this.poll = null;
      };
      this.visSub = onVisibilityChange((visible) => {
        if (myGen !== this.playGen || this.player !== player) return;
        if (visible) {
          // 복귀 즉시 현재 위치로 하이라이트를 맞춘다(다음 단어를 기다리지 않게).
          advance((player.currentTime || 0) * 1000);
          resync();
          startPoll();
        } else {
          stopPoll();
        }
      });

      // 재생 진행 감시(stats.ts): 오디오가 벽시계 × 배속만큼 실제로 전진하는지. 전진하지
      // 못한 몫 = 언더런/스톨 = 사용자가 듣는 끊김. "합성이 못 따라감(starved)"과 "재생 자체가
      // 끊김(stall)" 중 어느 쪽인지를 이 두 수치가 가른다(교차검증 지적 2026-07-13 — 계측이
      // 합성 쪽만 보면 반대 가설을 배제하지 못한다).
      const playRate = sherpaPlaybackRate(params.rate, synth.trimFactor);
      let lastWall = 0;
      let lastPos = 0;

      this.statusSub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (myGen !== this.playGen || this.player !== player) return;
        if (st?.error) { this.teardownPlayback(); handlers.onError?.(new Error('오프라인 음성 재생 오류')); return; }
        const posMs = (st?.currentTime || 0) * 1000;
        const now = Date.now();
        if (st?.playing && lastWall > 0) {
          recordPlaybackProgress(now - lastWall, posMs - lastPos, playRate);
        }
        // 일시정지 구간은 벽시계만 흐르므로 기준점을 리셋(정지를 끊김으로 세지 않게).
        lastWall = st?.playing ? now : 0;
        lastPos = posMs;
        advance(posMs);
        if (st?.didJustFinish) {
          // 남은 경계를 소진(문장 끝까지 하이라이트). 화면이 꺼져 있으면 커서만 밀고 통지는
          // 생략 — 보이지도 않는 자막을 문장마다 몰아서 리렌더할 이유가 없다.
          const notify = subtitlesVisible();
          while (bi < boundaries.length) {
            if (notify) handlers.onBoundary?.(boundaries[bi].charIndex, boundaries[bi].charLen);
            bi++;
          }
          this.teardownPlayback();
          handlers.onDone?.();
        }
      });

      if (subtitlesVisible()) startPoll();

      player.play();
    } catch (e) {
      this.teardownPlayback();
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export const sherpaEngine = new SherpaTtsEngine();
