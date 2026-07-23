import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { cacheDirectory, deleteAsync } from 'expo-file-system/legacy';
import { createTTS, saveAudioToFile } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine as NativeTts } from 'react-native-sherpa-onnx/tts';
import type { TtsEngine, SpeakParams, SpeakHandlers, EngineVoice } from '../TtsEngine';
import { sherpaModelPath } from '../../lib/sherpaModel';
import {
  sherpaModelSpeed,
  sherpaPlaybackRate,
  sherpaTrimEnabled,
  sherpaTempoComp,
  sherpaRubato,
  sherpaPaceComp,
} from './rate';
import { disposePlayer } from '../disposePlayer';
import {
  compressSilence,
  trimEdgeSilence,
  quietRuns,
  LEAD_PAD_MS,
  leadPadMsFor,
  TRAIL_PAD_MS,
  EDGE_FADE_MS,
} from './smartSpeed';
import { normalizeForSpeech, SPOKEN_QUOTES } from './normalizeKo';
import { chunkForSynthesis, hasClauseComma, chunkPauseJitterMs } from './chunkKo';
import { makeBreathSamples, speechStats, breathDurMs } from './breathWav';
import { estimateWordBoundaries, type WordBoundary } from './align';
import { recordSynth, recordStarvation, recordPlaybackProgress } from './stats';
import { subtitlesVisible, onVisibilityChange } from '../../lib/visibility';

// trimFactor: 스마트 스피드(무음 압축)로 이미 번 배속(미압축=1) — 재생속도에서 이만큼 덜어낸다.
// tempoComp·rubatoRaw: 이 문장의 완급 인자(텍스트 순수 함수 — 합성 시 계산해 실어 둔다).
// v1.26.1 부터 완급은 파일에 굽지 않고 재생 스트레치에 곱한다(sherpaPaceComp — 모델 speed 의
// F0 부작용 실측이 근거, rate.ts). rubato 설정 토글은 재생 시점 params 로 가르므로 캐시
// 파일은 설정 무관 유효.
type Synth = {
  uri: string;
  boundaries: WordBoundary[];
  trimFactor: number;
  tempoComp: number;
  rubatoRaw: number;
  // 트림 후 "발화 구간" 추정 길이(파일 길이 − 머리/꼬리 패드, ≤3× 경로만 — >3×는 Infinity).
  // 초단문("예!")이 고배속에서 실시간 수백 ms 미만으로 압축돼 통째로 안 들리는 것을 막는
  // 재생속도 하한 캡(effectivePlaybackRate)의 근거.
  speechMs: number;
};
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
// 메모리: 파일은 디스크 캐시(메모리 아님) — 44.1kHz WAV ≈ 1MB/5초 × 36 ≈ 36MB(cacheSweep 정리).
// v1.27.2: 24→36(prefetchUnits 20→30 동반) — 사용자 기기가 2.5× 합성 예산에 걸쳐 있어
// (느린 기기 경고 발동 실측) 버퍼를 더 깊게 잡아 CPU 스파이크 지터 흡수 폭을 키운다.
const MAX_CACHE = 36;
// 미리 만들어 두는 AudioPlayer 수 상한. 파일 캐시(8)와 달리 플레이어는 네이티브 자원이라
// 다음 발화 몫만 준비해 둔다(문장 시작 즉시 재생 효과는 1~2개로 이미 다 얻는다).
const MAX_PRELOAD = 2;
// 네이티브 상태 이벤트 주기(ms). PiP에선 JS 타이머가 얼어붙어 이 이벤트만이 자막을 움직인다.
const STATUS_UPDATE_MS = 80;
// 합성 1건 상한(첫 호출의 모델 로드 포함). 네이티브 hang 시 직렬화 체인 전체가 영구
// 대기하는 것을 막는다 — 초과 시 이 건만 실패시키고(폴백 유도) 체인은 계속 흐른다.
const SYNTH_TIMEOUT_MS = 60_000;
// 초단문("예!"·"응.")의 발화 구간이 재생에서 차지해야 하는 최소 실시간(ms) —
// effectivePlaybackRate 가 이 아래로 압축되지 않게 재생속도를 낮춘다. 250ms =
// 통상 문장(발화 600ms+)은 2.5×에서도 캡이 설정 배속 위라 무영향인 보수값.
const MIN_REAL_SPEECH_MS = 250;
// 캡 대상 상한(v1.27.2): 발화가 이보다 길면 캡을 아예 안 건다. v1.27.1의 무제한 캡은
// 발화 250×배속 ms 미만의 "짧은 편 문장 전부"를 늦춰, 짧은 첫 세그먼트(분할 대사)로
// 시작하는 문장이 "처음엔 1×였다 빨라지는" 램프로 체감됐다(사용자 보고 2026-07-23).
// 진짜 초단문(감탄사·단답)만 대상으로 좁힌다.
const SHORT_CAP_MAX_SPEECH_MS = 400;
// 캡 하한 = 설정 배속의 60%. 1×까지 뚝 떨어뜨리면 주변 문장(2.5×)과의 대비가 램프로
// 들린다 — "예!"(발화 300ms)는 2.5×에서 1.5× 안팎 = 실 200ms(가청 충분·대비 완화).
const SHORT_CAP_FLOOR_RATIO = 0.6;
// 낱자 없는 발화의 무음 길이(파일에 굽는 값 — 재생 스트레치로 배속 비례 축소).
const SILENT_UTTERANCE_MS = 600;
// 낱자(문자·숫자) 판정 — 무음 발화 분기(doSynthesize)용.
const SPOKEN_HAS_WORD = /[\p{L}\p{N}]/u;

// ── 장문 절 조립·숨소리 파라미터(≤3× 기준 체감, >3× 는 compressSilence 가 재압축) ──
// 절 이음새 쉼 = 절 꼬리 80 + 삽입 240 + 절 머리 40(LEAD_PAD_MS) ≈ 360ms.
// 근거(실측 2026-07-18): 모델이 장문을 통짜로 읽을 때 절(쉼표) 경계 쉼은 400~440ms 인데
// 구값 120(합계 240ms)은 그 절반이라 분할 문장만 절 경계를 몰아쳐 "갑자기 빨라짐/씹힘"으로
// 들렸다(사용자 보고). 문장 간 쉼(TRAIL 320+LEAD 40=360ms)을 넘지 않게 360 에 캡.
const INTER_CHUNK_PAUSE_MS = 240;
// 합성 들숨(v1.26.0)이 든 이음새 구조 = 절 꼬리 80 + 앞 무음 40 + 들숨 130~170(v1.26.2
// 청취 선택 — breathWav.ts) + 뒤 무음 60 + 절 머리 40 ≈ 350~390ms — 일반 절 경계
// (195~240 삽입 ≈ 315~360ms)와 거의 동률이라 숨 유무가 리듬을 흔들지 않는다.
// 뒤 무음(60ms)은 들숨 끝과 발화 어택을 분리하는 최소 간격.
// ⚠️ 하이라이트 정합: 들숨 피크는 생성 시점에 align.ts 의 BREATHY_THRESH 아래로 스케일돼
// (breathWav.ts) 앞뒤 무음과 함께 하나의 긴 쉼(≥ PAUSE_MIN_MS)으로 분류된다 — 하이라이트가
// 들숨에서 멈췄다 발화 재개에 맞춰 전진.
const BREATH_PRE_MS = 40;
const BREATH_POST_MS = 60;
const CHUNK_TRAIL_PAD_MS = 80;
// 숨소리(breathApplies)의 값싼 1차 게이트 최소 길이(원문 글자). 실제 발동(breathEffective)은
// "절 분할이 일어난 문장"(청크 2+)에만 — 들숨은 분할 이음새에 파형으로 삽입되므로(v1.26.0,
// `<breath>` 태그는 이 팩 미지원 실측으로 폐기 — breathWav.ts 주석) 이음새가 없으면 심을
// 곳이 없다. 사람 낭독자도 짧은 문장의 쉼표마다 숨쉬지 않는다(들숨 간격 실측 2~6초).
const BREATH_MIN_CHARS = 12;

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
  readonly prefetchUnits = 30;

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
  // 현재 재생 중 문장의 캐시 키·합성 결과 — suspend 시 파일을 캐시로 반환해, 재개할 때 같은
  // 문장이 재합성 없이(캐시 히트) 즉시 시작되게 한다.
  private currentKey: string | null = null;
  private currentSynth: Synth | null = null;
  private pendingSynth: CacheEntry | null = null;
  private cache = new Map<string, CacheEntry>();
  // 현재 재생 중 오디오의 합성 파라미터 — setRate 라이브 적용 가능 판정용.
  private currentModelSpeed: number | null = null;
  private currentTrimEnabled: boolean | null = null;
  private currentTrimFactor = 1;
  // 현재 문장의 rubato 설정 스냅샷 — setRate/setRateApprox 가 완급을 "요청된 rate 기준"으로
  // 재계산할 때 쓴다(compFor). 완급 값 자체를 저장하지 않는 이유: >3×에서 시작한 문장(comp
  // 게이트로 1)을 ≤3×로 내리면 저장값이 stale — 교차검증 codex CRITICAL 2026-07-20.
  private currentRubatoOn = false;

  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void {
    const myGen = ++this.playGen;
    this.teardownPlayback();
    const key = this.keyOf(text, params);
    this.currentKey = key;
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key); // 소비: 파일 소유권을 재생 쪽으로 이전(선행합성 히트 = 부드러운 자동진행)
    } else {
      // 캐시 미스 = 지금 당장 들려줄 이 문장이 아직 안 만들어졌다. 합성 체인은 같은 네이티브
      // 인스턴스라 1건씩 직렬이고 FIFO 라, 큐에 이미 쌓인 선행합성(미래 문장)이 이 문장보다 앞서
      // 있으면 재생이 그 뒤에서 수십 초~수 분을 기다린다 = "배속 바꾸면 멈춤"의 진짜 원인(실측
      // 2026-07-16: 재생 중 −/+ 로 배속을 빠르게 오르내리면 재발화가 겹치며 선행합성이 현재 문장
      // 앞을 막아 ~80s+ 정지). 그래서 큐에서 "아직 안 끝난" 선행합성만 전부 취소하고(취소분은
      // doSynthesize 진입 즉시 throw 되어 체인이 곧장 다음으로 넘어감) 이 문장을 최우선으로 만든다.
      // 이미 완료된 선행합성(파일)은 체인을 막지 않으므로 남긴다(2026-07-18) — 뒤로 seek·일시정지
      // 후 재개 때 애써 만든 앞 버퍼를 태우고 0에서 다시 쌓는 낭비(그 자체가 초반 리듬 흔들림)를
      // 없앤다. 미래분은 아래 prefetch 루프가 곧바로 다시 채운다. 정상 자동진행은 항상 캐시 히트라
      // 이 경로를 타지 않는다.
      this.cancelUnfinished();
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
        // × paceComp(완급, v1.26.1): 피치 보존 스트레치로 문장별 템포 변주 — playFile 과 동일식.
        try { p.setPlaybackRate(this.effectivePlaybackRate(synth, params)); } catch { /* noop */ }
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

  // 일시정지 전용 정지(2026-07-18): 재생·진행 중 합성만 내리고, **완료된 선행합성(파일)은
  // 남긴다** — 재개가 캐시 히트로 시작해 버퍼가 따뜻하다(정지할 때마다 파이프라인을 0에서
  // 다시 쌓는 초반 리듬 흔들림 제거). 현재 문장 파일도 캐시로 반환해 재개 첫 문장이 즉시 나온다.
  // 남는 건 디스크 파일뿐: 미완료 합성은 취소하고(큐 대기분은 즉시 소멸, 인플라이트 1건은
  // 중단 API 가 없어 마저 돌고 결과만 폐기), 프리로드 플레이어(네이티브 자원)도 해제한다.
  // 완전 정지(엔진 전환·에러·책 끝·언로드·모델 삭제)는 여전히 stop().
  suspend(): void {
    this.playGen++;
    this.recacheCurrent();
    this.teardownPlayback();
    for (const [k, e] of this.cache) {
      if (e.synth) releasePreload(e);
      else {
        this.cache.delete(k);
        e.cancel();
      }
    }
  }

  // 현재 재생 중 문장의 파일을 캐시에 되돌린다(suspend 전용). teardownPlayback 의 파일 삭제를
  // 피하려고 소유권(currentUri)을 캐시 엔트리로 넘긴다.
  private recacheCurrent(): void {
    const key = this.currentKey;
    const synth = this.currentSynth;
    if (!key || !synth || !this.currentUri) return;
    // 같은 키(반복 문장: "네." 등)가 이미 캐시에 있을 때 — 완료본이면 그걸 쓰면 되니 현재
    // 파일은 teardown 이 정리하게 두고, 미완료면 취소하고 현재 완료 파일로 대체한다(안 하면
    // suspend 루프가 그 미완료를 지워 "재개 시 현재 문장 캐시 히트" 보장이 깨짐 — 교차검증
    // 발견 2026-07-18).
    const prev = this.cache.get(key);
    if (prev?.synth) return;
    if (prev) {
      this.cache.delete(key);
      prev.cancel();
    }
    this.currentUri = null;
    const entry: CacheEntry = {
      promise: Promise.resolve(synth),
      synth,
      cancel: () => {
        entry.disposed = true;
        releasePreload(entry);
        deleteAsync(synth.uri, { idempotent: true }).catch(() => { /* noop */ });
      },
    };
    this.cache.set(key, entry); // Map 뒤(최신) 삽입 — evict 는 오래된 것부터 지우므로 안전
    this.evict();
  }

  // 재생 중 배속 라이브 변경. 합성은 자연속도 고정이라(≤3×: 모델 speed=1·무음압축 off)
  // 그 구간 안에서는 스트레치만 바꿔 끼우면 된다 — 재합성·끊김 0. 합성 파라미터가 달라지는
  // 경계(1× 이하·3× 초과)를 넘나들면 false — 호출부가 재발화로 폴백.
  // ⚠️ 불변식(setRateApprox 공통): currentModelSpeed 는 "순수" sherpaModelSpeed(rate).
  // v1.26.1: 완급(currentPaceComp)은 재생 스트레치 곱으로 여기서도 유지 — 배속 변경 후에도
  // 문장의 net 템포(완급 × rate 비례)가 이어진다. 경계 판정(modelSpeed/trim)엔 미포함.
  setRate(rate: number): boolean {
    if (!this.player || this.currentModelSpeed === null) return false;
    if (this.currentModelSpeed !== sherpaModelSpeed(rate)) return false;
    if (this.currentTrimEnabled !== sherpaTrimEnabled(rate)) return false;
    try {
      this.player.setPlaybackRate(sherpaPlaybackRate(rate, this.currentTrimFactor) * this.compFor(rate));
      return true;
    } catch {
      return false;
    }
  }

  // 경계 넘는 배속 변경의 즉각 반영(TtsEngine.setRateApprox 계약 참조). 현재 오디오의 실제
  // 분담(모델 speed × 트림)을 알고 있으므로, 잔여 재생 스트레치만 목표 배속에 맞춰 당긴다:
  // 곱 불변식(모델 × trim × 스트레치 = 설정 배속)을 그대로 푼 것. 품질은 이 문장 잔여 동안만
  // 타협(스트레치가 3을 넘으면 CER 저하 구간) — 다음 문장부터 정식 합성이 이어받는다.
  // 완급은 compFor 로 요청 rate 기준 재계산(>3×=1 게이트 포함) — stale comp 방지(compFor 주석).
  setRateApprox(rate: number): boolean {
    if (!this.player || this.currentModelSpeed === null) return false;
    try {
      const target = Math.max(
        0.5,
        Math.min(10, (rate / (this.currentModelSpeed * this.currentTrimFactor)) * this.compFor(rate)),
      );
      this.player.setPlaybackRate(target);
      return true;
    } catch {
      return false;
    }
  }

  // 미완료 선행합성만 공개적으로 취소(재생·완료 파일 불변) — 배속 경계 변경 직후 옛 배속
  // 큐 제거용(player.applyRate).
  cancelPending(): void {
    this.cancelUnfinished();
  }

  async getVoices(): Promise<EngineVoice[]> {
    // Supertonic 3 = 화자 10(sid 0~9). 라벨은 실청취로 고르게 안내(성별 메타데이터 없음).
    // 성별 라벨 = F0 자기상관 실측(2026-07-20, sid 0~4 여 172~253Hz / 5~9 남 85~151Hz —
    // speakerGender.ts 상수와 같은 근거). Supertone voice_styles F1~F5/M1~M5 명명과 일치.
    return Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      name: `화자 ${i + 1} (${i <= 4 ? '여' : '남'})`,
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
  // 숨소리 게이트(값싼 1차 판정) — 절 경계(쉼표)가 있는 최소 길이 이상 문장에만.
  // 자릿수 쉼표(12,500)는 정규화로 사라져 심을 곳이 못 되므로 판정에서 제외(hasClauseComma).
  // >3×(스마트 스피드)는 훑어 듣는 속도라 숨 무의미 — 제외.
  private breathApplies(text: string, params: SpeakParams): boolean {
    return (
      !!params.breath &&
      langOf(params.language) === 'ko' &&
      !sherpaTrimEnabled(params.rate) &&
      text.length > BREATH_MIN_CHARS &&
      hasClauseComma(text)
    );
  }

  // 숨소리가 "실제로" 이 발화 오디오에 들어가는가 — keyOf 는 반드시 이 판정을 쓴다.
  // 게이트(breathApplies)만으로 키를 가르면 "키는 b 인데 삽입은 no-op"인 케이스(정규화로
  // 쉼표 소실·분할 미발생 등)에서 숨 없는 동일 WAV 가 별도 키로 이중 합성된다(교차검증
  // 지적 2026-07-18). doSynthesize 와 동일 경로(정규화→분할)로 선판정해 키=오디오 일치를
  // 구조적으로 보장한다. v1.26.0: 들숨은 절 이음새 삽입뿐이므로 "분할됨(청크 2+)"이 곧 실효.
  // 비용: 문장당 정규화·분할 1회 추가(짧은 문자열 정규식 — 합성 비용 대비 무시 가능) —
  // breath 옵션이 꺼져 있으면 게이트에서 즉시 false 라 비용 0.
  private breathEffective(text: string, params: SpeakParams): boolean {
    if (!this.breathApplies(text, params)) return false;
    const spoken = langOf(params.language) === 'ko' ? normalizeForSpeech(text) : text;
    return chunkForSynthesis(spoken).length > 1;
  }

  // 이 문장의 재생 완급(sherpaPaceComp 인자 조합 — 텍스트 순수 함수는 합성 시 Synth 에
  // 실어 두고, rubato 설정·배속은 재생 시점 params 로 가른다). 파일에 굽지 않으므로 캐시
  // 키와 무관(v1.26.1 — 모델 speed 의 F0 부작용 실측이 이동 근거, rate.ts).
  private paceComp(synth: Synth, params: SpeakParams): number {
    return sherpaPaceComp(synth.tempoComp, synth.rubatoRaw, {
      rate: params.rate,
      rubatoOn: !!params.rubato,
    });
  }

  // 유효 재생속도 = 배속 보상식 × 문장 완급. 배속 계산은 과거 교차검증 CRITICAL 이 반복된
  // 깨지기 쉬운 지점이라 수식을 한 곳에 묶는다(교차검증 권고 2026-07-20) — preload·playFile
  // 이 이 헬퍼를 쓰고, setRate/setRateApprox 는 compFor(현재 문장 Synth 재계산)로 같은
  // 곱을 유지한다(라이브 변경 잔여 구간만 초단문 캡이 빠지는 건 수용 — 수명이 문장 하나).
  //
  // 초단문 실시간 하한(v1.27.1): "예!" 같은 2~3음절 발화(발화 ~300ms)는 2.5×에서 실 120ms
  // 로 압축돼 재생 시작 손실·순간 집중 어느 쪽으로든 "아예 안 읽은 것"처럼 들린다(사용자
  // 보고 2026-07-23). 발화 구간이 최소 MIN_REAL_SPEECH_MS 는 실시간을 차지하도록 재생속도를
  // 낮춘다 — 사람 낭독자도 감탄사·짧은 대답은 배속 비례로 압축하지 않는다. 일반 문장
  // (발화 600ms+)은 캡이 설정 배속 위라 무영향.
  private effectivePlaybackRate(synth: Synth, params: SpeakParams): number {
    const base = sherpaPlaybackRate(params.rate, synth.trimFactor) * this.paceComp(synth, params);
    // 캡 미적용: >3× 스마트 스피드 경로(Infinity)와 초단문 아닌 발화(SHORT_CAP_MAX 주석).
    if (!Number.isFinite(synth.speechMs) || synth.speechMs >= SHORT_CAP_MAX_SPEECH_MS) return base;
    const cap = Math.max(1, base * SHORT_CAP_FLOOR_RATIO, synth.speechMs / MIN_REAL_SPEECH_MS);
    return Math.min(base, cap);
  }

  // 현재 재생 중 문장의 완급을 "요청된 rate" 기준으로 재계산. 저장된 comp 를 재사용하면
  // >3×(게이트로 1)에서 시작해 ≤3×로 내려오는 라이브 변경에서 완급이 소실된다(교차검증
  // codex CRITICAL 2026-07-20 — 그 문장 잔여가 최대 ~17% 과속). 문장 전환 시 정식 경로가
  // 이어받으므로 이 값의 수명은 현재 문장 잔여뿐.
  private compFor(rate: number): number {
    if (!this.currentSynth) return 1;
    return sherpaPaceComp(this.currentSynth.tempoComp, this.currentSynth.rubatoRaw, {
      rate,
      rubatoOn: this.currentRubatoOn,
    });
  }

  private keyOf(text: string, params: SpeakParams): string {
    const sid = params.voiceId || '0';
    // breath 는 숨소리가 파일에 구워지므로 "실효" 여부만 키에 포함(토글 시 재합성 유도).
    // (v1.26.1: 루바토 'r' 플래그 폐지 — 완급이 재생 스트레치로 이동해 파일에 안 구워진다.
    //  같은 문장은 rubato 토글과 무관하게 같은 파일을 재사용한다.)
    const breath = this.breathEffective(text, params) ? 'b' : '';
    // 머리 패드도 파일에 구워진다 — 배속 비례 패드(v1.27.1, leadPadMsFor)라 짧은 문장은
    // 배속 구간별로 키가 갈린다(일반 문장은 상수 40 = 종전대로 배속 무관 단일 키).
    const lead = this.leadPadOf(text, params);
    return `${sid}\u0000${sherpaModelSpeed(params.rate)}\u0000${langOf(params.language)}\u0000${breath}\u0000${lead}\u0000${text}`;
  }

  // 이 발화의 머리 무음 패드(ms) — keyOf 와 doSynthesize 가 "반드시" 이 한 함수를 공유한다.
  // 판정이 갈리면 배속별 패드가 파일에 구워진 채 같은 키를 쓰게 돼(짧은 문장 캐시 오염)
  // 배속 변경 후 옛 패드 파일이 재생된다. 원문이 충분히 길면(24자 초과 — 정규화로 8자
  // 이하가 되는 건 한자 주석 대량 제거 같은 예외뿐) 정규화 비용 없이 일반 패드로 조기 확정.
  private leadPadOf(text: string, params: SpeakParams): number {
    if (langOf(params.language) !== 'ko') return leadPadMsFor(text, params.rate);
    // 지름길 문턱은 따옴표를 벗긴 길이 기준(정규화도 벗기므로) — 따옴표가 잔뜩 붙은 짧은
    // 대사가 원문 길이만으로 일반 문장 취급되는 것을 막는다(교차검증 codex 지적).
    if (text.replace(SPOKEN_QUOTES, '').length > 24) return LEAD_PAD_MS;
    return leadPadMsFor(normalizeForSpeech(text), params.rate);
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

  // 아직 완료되지 않은(체인을 점유할 수 있는) 합성만 취소 — 완료된 파일은 남긴다.
  private cancelUnfinished(): void {
    for (const [k, e] of this.cache) {
      if (e.synth) continue;
      this.cache.delete(k);
      e.cancel();
    }
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
    this.currentRubatoOn = false;
    this.currentKey = null;
    this.currentSynth = null;
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

    // 발화 정규화(한국어만): 숫자→한글 읽기, 괄호 한자 주석 제거(normalizeKo.ts — 근거·실측
    // 그 파일). 합성 입력만 바꾸고, 하이라이트 경계는 아래에서 "원문" 기준으로 계산한다.
    const lang = langOf(params.language);
    const spoken = lang === 'ko' ? normalizeForSpeech(text) : text;

    // 낱자(문자·숫자) 없는 발화("“…….”" 침묵 대사·기호뿐인 문장)는 모델을 부르지 않고
    // 무음을 굽는다. 실측(2026-07-23 ell-probe3): 이 모델은 구두점-only 입력에 "큰 유성
    // 잡음"을 만든다 — "…" 단독 피크 0.535, "…," 0.772(일반 발화 0.3~0.6과 동급). 사용자
    // 보고 "'……' 문장에서 '으크' 소리"의 정체. 빈 문자열 합성의 실패→서킷브레이커 경로도
    // 함께 막는다(v1.27.1의 '.' 대체를 이 경로가 대체 — '.'도 침묵이 목적이면 모델 호출
    // 자체가 불필요). speechMs=Infinity: 무음은 초단문 캡 대상이 아니다(설정 배속 그대로
    // 짧게 지나가는 것이 침묵 대사의 의도).
    if (!SPOKEN_HAS_WORD.test(spoken)) {
      const sampleRate = 44100;
      const silent = new Array<number>(Math.round((sampleRate * SILENT_UTTERANCE_MS) / 1000)).fill(0);
      const boundaries = estimateWordBoundaries(text, silent, sampleRate);
      const dir = (cacheDirectory || '').replace(/^file:\/\//, '');
      if (!dir) throw new Error('캐시 디렉토리 없음');
      const name = `sherpa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`;
      await saveAudioToFile({ samples: silent, sampleRate }, `${dir}${name}`);
      const uri = `file://${dir}${name}`;
      if (state.cancelled) {
        deleteAsync(uri, { idempotent: true }).catch(() => { /* noop */ });
        throw new Error('cancelled');
      }
      state.uri = uri;
      recordSynth(Date.now() - synthStart, SILENT_UTTERANCE_MS);
      return { uri, boundaries, trimFactor: 1, tempoComp: 1, rubatoRaw: 1, speechMs: Infinity };
    }
    // 장문은 절(쉼표) 단위로 나눠 각각 합성 후 이어 붙인다(chunkKo.ts — 장문 운율 붕괴 대책).
    const chunks = lang === 'ko' ? chunkForSynthesis(spoken) : [spoken];

    // 숨소리(선택, v1.26.0): 절 분할이 일어난 문장의 이음새에 "합성 들숨" 파형을 삽입한다
    // (synthesizeChunks — 파라미터·근거는 breathWav.ts). 연혁: v1.22.0 "따로 합성한 숨을
    // 문장 앞에 부착"은 과대 음량(말소리 −7.6dB)으로 기각 → v1.22.1~1.25 `<breath>` 태그
    // 인라인은 "이 팩이 태그를 지원하지 않음"이 대조군 실측으로 반증돼 폐기(무의미 태그와
    // 차이 없음, 삽입 구간 −45dB 사실상 무음 — "숨 거의 안 들림" 체감의 진범, 2026-07-20).
    // 판정은 breathEffective 와 동일 조건(분할됨) — 키=오디오 정합.
    const breathOn = this.breathApplies(text, params) && chunks.length > 1;

    // ⚠️ generateSpeech 로 바꾸지 말 것: 그 경로의 일반 모델 분기는 네이티브에서
    // dispatchGenerate(text, sid, speed)로 options(extra.lang)를 통째로 버린다(소스 실측
    // 2026-07-07) — 한국어가 영어 발음으로 깨지는 v1.6.2 버그 재발. lang 배선 패치
    // (patches/react-native-sherpa-onnx+0.4.3.patch)는 이 타임스탬프 경로에만 걸려 있다.
    const gen = async (input: string): Promise<{ samples: ArrayLike<number>; sampleRate: number }> => {
      const audio = await native.generateSpeechWithTimestamps(input, {
        sid: Number.parseInt(params.voiceId || '0', 10) || 0,
        // v1.26.1: 합성 speed 는 "순수" 배속 분담(sherpaModelSpeed)만. 템포 평준화·루바토는
        // 모델 speed 가 F0(음높이)까지 바꾼다는 실측(0.90 → +10Hz, tone_probe EXP2 — 문장마다
        // 톤이 흔들리는 "톤 깨짐"의 원인)에 따라 재생 스트레치(피치 보존)로 이동했다 —
        // paceComp/sherpaPaceComp. 완급 인자는 아래 반환 Synth 에 실어 재생부가 곱한다.
        speed: sherpaModelSpeed(params.rate),
        extra: { lang },
        // 자막 결과는 버린다(sentence 단위 = 최소 비용) — fast 모드는 앞뒤 무음·쉼을 발화로
        // 깔고 계산한 글자수 비례 추정이라 하이라이트가 수백 ms 어긋났다(Whisper 대조 실측
        // 2026-07-07). 단어 타임스탬프는 아래 자체 정렬(align.ts)로 계산한다.
        subtitles: { mode: 'fast', granularity: 'sentence' },
      });
      if (state.cancelled) throw new Error('cancelled');
      if (!audio.samples?.length) throw new Error('오프라인 음성 합성 실패(빈 오디오)');
      return audio;
    };

    // 원본 44.1kHz 그대로 사용. v1.17 의 22.05kHz 다운샘플은 폐기(2026-07-15) — 값싼 3탭
    // 저역통과가 나이퀴스트(11kHz) 근처 앨리어싱을 통과시켜 "지직거림 + 발음 뭉개짐"을 냈다
    // (제대로 된 폴리페이즈 리샘플이면 그 대역을 −2.7dB 깎지만 3탭은 +0.2dB 로 흘려보냄, 왜곡
    // −30dB — 사용자 보고 + scipy 대조 실측). Whisper CER 은 0% 였지만 그건 "알아들린다"일 뿐
    // "좋게 들린다"가 아니었다(자기함정). 검증된 원본 유지.
    let rawSamples: ArrayLike<number>;
    let sampleRate: number;
    if (chunks.length === 1) {
      const audio = await gen(chunks[0]);
      rawSamples = audio.samples;
      sampleRate = audio.sampleRate;
    } else {
      // 절 단위 합성 + 조립: 각 절의 앞뒤 죽은 공기(~0.9s)를 짧은 패드로 다듬고, 이음새에
      // 쉼표 숨(INTER_CHUNK_PAUSE)을 넣는다. >3× 는 아래 compressSilence 가 이 쉼도 함께
      // 압축하므로 초고배속의 밀도는 유지된다.
      const assembled = await this.synthesizeChunks(chunks, gen, breathOn);
      rawSamples = assembled.samples;
      sampleRate = assembled.sampleRate;
    }

    // 무음 처리(smartSpeed.ts):
    // - ≤3×: 앞뒤 무음만 트림(말소리·내부 쉼 불변, 속도 보상 없음) — Supertonic 이 문장마다
    //   박는 앞 ~0.4s·뒤 ~0.5s 죽은 공기가 "문장 전환 텀"의 주범(실측 2026-07-07).
    // - >3×(스마트 스피드): 내부 긴 쉼까지 압축하고 그만큼 재생 스트레치를 덜어낸다.
    let samples: number[];
    let trimFactor = 1;
    // 발화 구간 추정(초단문 재생속도 캡용 — Synth.speechMs 주석). >3× 압축 경로는 캡 미적용.
    let speechMs = Infinity;
    if (sherpaTrimEnabled(params.rate)) {
      const c = compressSilence(rawSamples, sampleRate);
      samples = c.samples;
      trimFactor = c.factor;
    } else {
      // 짧은 문장은 머리 여유를 키운다(배속 비례 — "짧은 말 씹힘" 대책, smartSpeed.ts).
      // ⚠️ 패드는 반드시 leadPadOf(키 계산과 동일 함수) — 갈리면 캐시 키=오디오 정합이 깨진다.
      const leadPad = this.leadPadOf(text, params);
      samples = trimEdgeSilence(rawSamples, sampleRate, leadPad, undefined, EDGE_FADE_MS);
      // 발화 구간 = 전체 − 앞/뒤 무음 런 "실측"(quietRuns). "파일 − 패드 상수" 산식은 큰
      // 패드 요구치(2.5×+ 짧은 문장)에서 트림이 스킵되면 모델의 원 무음(~0.9s)이 발화로
      // 계산돼 초단문 캡이 무력화된다(교차검증 Claude 지적 — 하필 이 기능의 표적 구간).
      const runs = quietRuns(samples, sampleRate);
      let headQ = 0;
      let tailQ = 0;
      if (runs.length) {
        const first = runs[0];
        const last = runs[runs.length - 1];
        if (first.s === 0) headQ = first.e;
        if (last.e === samples.length) tailQ = Math.min(samples.length - headQ, samples.length - last.s);
      }
      speechMs = Math.max(0, ((samples.length - headQ - tailQ) / sampleRate) * 1000);
    }
    // 단어 하이라이트: 최종(트림 후) 샘플에서 발화 구간 위에만 글자수 비례 분배 — 쉼 동안
    // 하이라이트가 전진하지 않고, 무음 오프셋 오차가 원천 제거된다.
    // breathy: 숨소리가 심긴 발화는 들숨(저진폭)을 쉼으로 분류하는 높은 문턱을 쓴다(align.ts).
    const boundaries = estimateWordBoundaries(text, samples, sampleRate, { breathy: breathOn });
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
    // 완급 인자(재생 스트레치용) — 음절 산정은 정규화 "후"(spoken) 기준(숫자·기호 많은
    // 원문은 실제 발화가 훨씬 길어 원문 기준이면 짧은 문장으로 오판, 교차검증 2026-07-19).
    // 루바토 해시는 원문(text) 기준 — pacing.ts afterRubato(재생부)와 같은 입력이어야
    // "루바토 문장 뒤 숨 고르기" 판정이 일치한다.
    return {
      uri,
      boundaries,
      trimFactor,
      tempoComp: sherpaTempoComp(spoken),
      rubatoRaw: sherpaRubato(text),
      speechMs,
    };
  }

  // 절 청크들을 순서대로 합성해 한 문장 파형으로 조립한다(직렬 — 이미 synthChain 안).
  // 각 절의 앞뒤 죽은 공기(~0.9s)는 짧은 패드로 다듬고 이음새에 쉼표 숨을 넣는다.
  // 마지막 절 꼬리만 문장 꼬리 패드(TRAIL_PAD_MS)를 유지해, 단일 합성 경로와 같은
  // 문장 간 숨이 보존되게 한다.
  private async synthesizeChunks(
    chunks: string[],
    gen: (input: string) => Promise<{ samples: ArrayLike<number>; sampleRate: number }>,
    breathOn = false,
  ): Promise<{ samples: number[]; sampleRate: number }> {
    const pieces: number[][] = [];
    let sampleRate = 44100;
    for (let i = 0; i < chunks.length; i++) {
      const audio = await gen(chunks[i]);
      sampleRate = audio.sampleRate;
      const trail = i === chunks.length - 1 ? TRAIL_PAD_MS : CHUNK_TRAIL_PAD_MS;
      pieces.push(trimEdgeSilence(audio.samples, sampleRate, LEAD_PAD_MS, trail, EDGE_FADE_MS));
    }
    // 이음새 쉼: 기본 INTER_CHUNK_PAUSE_MS − 결정론 지터(195~240ms — chunkPauseJitterMs
    // 주석, v1.25.0). 숨 모드면 이음새마다 "앞 무음 + 합성 들숨 + 뒤 무음"(BREATH_PRE/POST
    // 주석) — 들숨 길이(240~320ms)는 뒤 절 텍스트의 결정론 변주(breathDurMs), 파형도 같은
    // 시드라 같은 문장은 항상 같은 숨(캐시 재생성 간 정합). 음량은 이 문장 발화 실측
    // RMS 기준 −18dB + 하이라이트 쉼 문턱 클램프(breathWav.ts).
    // ⚠️ 전체 무음(합성 실패 성격, rms 0)이어도 일반 이음새로 "폴백하지 않는다" — 폴백하면
    // 키('b')와 오디오(숨 없는 이음새)가 갈라져 캐시 키=오디오 정합이 깨진다(교차검증 codex
    // CRITICAL 2026-07-20). makeBreathSamples 가 rms 0 이면 무음을 반환하므로 숨 레이아웃을
    // 유지한 채 들숨만 조용해진다(어차피 발화 전체가 무음인 퇴화 케이스).
    const stats = breathOn ? speechStats(pieces) : null;
    const breaths: number[][] | null = stats
      ? pieces.slice(1).map((_, k) =>
          makeBreathSamples(sampleRate, breathDurMs(chunks[k + 1]), stats, chunks[k + 1]),
        )
      : null;
    const msSamples = (ms: number): number => Math.round((sampleRate * ms) / 1000);
    const gapBefore = (i: number): number => {
      if (breaths) return msSamples(BREATH_PRE_MS) + breaths[i - 1].length + msSamples(BREATH_POST_MS);
      return msSamples(INTER_CHUNK_PAUSE_MS - chunkPauseJitterMs(chunks[i]));
    };
    let total = 0;
    for (let i = 0; i < pieces.length; i++) total += (i > 0 ? gapBefore(i) : 0) + pieces[i].length;
    // 사전 할당 + 인덱스 복사(스프레드/push 금지 — 문장 하나가 수십만 샘플, smartSpeed 와 동일 이유).
    const out = new Array<number>(total);
    let w = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) {
        if (breaths) {
          for (let g = msSamples(BREATH_PRE_MS); g > 0; g--) out[w++] = 0;
          const b = breaths[i - 1];
          for (let j = 0; j < b.length; j++) out[w++] = b[j];
          for (let g = msSamples(BREATH_POST_MS); g > 0; g--) out[w++] = 0;
        } else {
          for (let g = gapBefore(i); g > 0; g--) out[w++] = 0;
        }
      }
      const p = pieces[i];
      for (let j = 0; j < p.length; j++) out[w++] = p[j];
    }
    return { samples: out, sampleRate };
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
      this.currentSynth = synth;
      this.currentModelSpeed = sherpaModelSpeed(params.rate);
      this.currentTrimEnabled = sherpaTrimEnabled(params.rate);
      this.currentTrimFactor = synth.trimFactor;
      // rubato 설정 스냅샷(compFor 용) — setRate 라이브 경로가 이 문장의 완급을 요청 rate
      // 기준으로 재계산해 곱는다(배속 변경 후에도 net 템포 유지, stale comp 방지).
      this.currentRubatoOn = !!params.rubato;
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
      // 1 로 되돌리는 경우 포함). × paceComp = 문장별 완급(피치 보존 스트레치, v1.26.1).
      try { player.setPlaybackRate(this.effectivePlaybackRate(synth, params)); } catch { /* noop */ }

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
      const playRate = this.effectivePlaybackRate(synth, params);
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
