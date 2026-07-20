// 합성 들숨 파형 생성(순수 함수) — 사람 낭독자의 들숨을 절 이음새·문단 전환에 심는다.
//
// 왜 "합성" 들숨인가(v1.26.0): `<breath>` 태그는 이 Supertonic 팩이 지원하지 않는다는 게
// 대조군 실측으로 반증됐다(2026-07-20, 무의미 태그 `<xyz>`가 더 긴 쉼 — tts.json 은 문자
// 임베더뿐이라 특수 토큰 사전 자체가 없음). 태그는 "모르는 문자"로 읽혀 쉼이 0.13s 늘 뿐
// 들숨이 아니었다("숨 거의 안 들림" 체감의 진범). 사람 낭독의 들숨은 잡음성 소리(마찰
// 기류)라 대역 잡음 + 상승-잦아듦 엔벨로프로 근사한다 — 출발점은 newyoutube
// supertonic_tts.py 이식(300~2600Hz·−18dB·0.30s), 이후 실기기 실청으로 재튜닝(아래 상수).
//
// 음량 원칙 두 가지(순서대로 적용, 작은 쪽 승):
// ① 사람 낭독 관례 = 말소리 RMS 대비 −18dB(실측 근거: v1.22.0 의 −7.6dB 는 "허~ 하고
//    시작, 너무 큼"으로 사용자 기각, 사람 낭독은 −15~−20dB).
// ② 하이라이트 정합 = 들숨 피크가 단어 정렬(align.ts)의 숨소리 모드 쉼 문턱(BREATHY_THRESH)
//    아래여야 한다 — 넘으면 들숨이 "발화"로 분류돼 하이라이트가 숨 구간을 전진한다(A/B
//    실측 2026-07-20: −18dB 들숨 피크 0.043 > 문턱 0.022 — ①만으로는 초과한다).

import { BREATHY_THRESH } from './align';

/** 들숨 음량: 말소리 RMS 대비(dB). 연혁: −18(관례) → −24(v1.26.1 "빗자루" 기각) →
 *  −30(v1.26.2 — 청취 세트에서 사용자가 "3번(≈−27)보다 더 작게" 선택 2026-07-20).
 *  ⚠️ −22dB(문턱 클램프 상당)보다 낮아야 실효 — 그 위 값은 클램프가 지배해 무효.
 *  사용자가 안 들린다고 하면 여기만 올리면 된다(−27 이 직전 청취 후보). */
export const BREATH_REL_DB = -30;
/** 문턱 대비 피크 안전 마진(0.85 = 문턱의 85%까지만). */
const THRESH_MARGIN = 0.85;
/** 소프트 클립 무릎(RMS 배수) — 과대 피크를 완만하게 눌러 들숨의 "칙" 튀는 순간을 없앤다
 *  (가우시안 잡음의 원 crest 는 4~5). 피크 "보장"은 이 상수가 아니라 makeBreathSamples ④의
 *  실측 피크 스케일이 담당한다(재정규화가 crest 를 도로 키울 수 있어 상수 가정은 불충분 —
 *  교차검증 Claude 지적 2026-07-20). */
const CREST_LIMIT = 3;
// 음색(v1.26.2): "평평한 대역 잡음"은 어떻게 잘라도 사람 숨이 아니다 — 넓게(300~2600)
// 자르면 "빗자루", 좁게(300~1500) 자르면 "코푸는 소리"(사용자 실청 2연속 기각). 사람
// 들숨은 성도 공명을 통과한 잡음("whispered h")이라, 포먼트 공명 피크(F1~F3)로 성형한다
// — 아래 FORMANTS 병렬 밴드패스 + 저레벨 광대역 공기(AIR_*).
const FORMANTS: ReadonlyArray<{ hz: number; q: number; gain: number }> = [
  { hz: 550, q: 5, gain: 1.0 },
  { hz: 1450, q: 6, gain: 0.7 },
  { hz: 2600, q: 7, gain: 0.4 },
];
const AIR_LO_HZ = 400;
const AIR_HI_HZ = 4000;
const AIR_GAIN = 0.18;
/** 엔벨로프: 서서히 차오르다(어택) 발화 직전 잦아든다(릴리즈) — 들숨의 자연 형태.
 *  v1.26.1: 어택 지수 1.5→2(더 완만한 진입), 릴리즈 0.15→0.25(급정지 완화). */
const ATTACK_PORTION = 0.65;
const RELEASE_PORTION = 0.25;

/** 들숨 길이(ms): 결정론 변주 — 사람의 들숨 길이는 매번 조금씩 다르다.
 *  같은 텍스트 = 같은 길이(캐시 파일과 정합). */
// 연혁: 240~320(v1.26.0) → 180~260(v1.26.1) → 130~170(v1.26.2 — 청취 세트 3번
// "짧고 조용히"를 사용자 선택, 평균 150ms). 존재감을 배경으로 눌러 "지 맘대로 끼어드는
// 소리"가 아니라 쉼의 질감이 되게 한다.
const DUR_BASE_MS = 130;
const DUR_VAR_MS = 40;
export function breathDurMs(seedText: string): number {
  return DUR_BASE_MS + (djb2(seedText) % (DUR_VAR_MS + 1));
}

// djb2 — pacing.ts·rate.ts 와 같은 계열(결정론 변주의 공용 도구).
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

// mulberry32 — 시드 결정론 PRNG(Math.random 금지: 같은 문장은 항상 같은 파형이어야
// 캐시 재생성 간 소리가 흔들리지 않는다).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// RBJ 밴드패스(정점 이득 상수형) 한 패스 — 포먼트 공명용.
function bandpass(src: Float64Array, sampleRate: number, fc: number, q: number): Float64Array {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha;
  const b2 = -alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  const out = new Float64Array(src.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < src.length; i++) {
    const xi = src[i];
    const yi = (b0 * xi + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    out[i] = yi;
  }
  return out;
}

// RBJ biquad 필터 한 패스(계수 고정 Q=0.707). type: 'hp' | 'lp'.
function biquad(x: Float64Array, sampleRate: number, fc: number, type: 'hp' | 'lp'): void {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) * Math.SQRT1_2; // Q=1/√2 → sin(w0)/(2Q) = sin(w0)·(√2/2)
  const a0 = 1 + alpha;
  let b0: number;
  let b1: number;
  let b2: number;
  if (type === 'hp') {
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
  } else {
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
  }
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    x[i] = yi;
  }
}

export type SpeechStats = { rms: number; peak: number };

/** 발화 통계(피크 + 유성 구간 RMS). 유성 = |x| > 피크의 5%(무음·쉼 제외 — 쉼까지 넣으면
 *  RMS 가 낮아져 들숨이 상대적으로 커진다). 전체 무음이면 rms 0(호출부가 들숨 생략). */
export function speechStats(pieces: ReadonlyArray<ArrayLike<number>>): SpeechStats {
  let peak = 0;
  for (const p of pieces) {
    for (let i = 0; i < p.length; i++) {
      const a = Math.abs(p[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) return { rms: 0, peak: 0 };
  const th = peak * 0.05;
  let sum = 0;
  let n = 0;
  for (const p of pieces) {
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (Math.abs(v) > th) {
        sum += v * v;
        n++;
      }
    }
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, peak };
}

/**
 * 들숨 파형 생성. 반환 샘플의 보장:
 * - RMS ≤ 말소리 RMS × 10^(BREATH_REL_DB/20) (사람 낭독 음량 관례)
 * - 피크 ≤ BREATHY_THRESH 문턱 × 0.85 (align.ts 가 이 구간을 "쉼"으로 분류 — 하이라이트
 *   가 들숨에서 멈췄다 발화 재개에 맞춰 전진)
 * - 결정론: 같은 (sampleRate, durMs, stats, seedText) → 같은 파형.
 */
export function makeBreathSamples(
  sampleRate: number,
  durMs: number,
  stats: SpeechStats,
  seedText: string,
): number[] {
  const n = Math.max(1, Math.round((sampleRate * durMs) / 1000));
  if (stats.rms <= 0 || stats.peak <= 0) return new Array<number>(n).fill(0);

  // ① 포먼트 성형 잡음: 공명 피크 3개(병렬 밴드패스) + 저레벨 광대역 공기.
  const rand = mulberry32(djb2(seedText));
  const noise = new Float64Array(n);
  for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;
  const x = new Float64Array(n);
  for (const f of FORMANTS) {
    const band = bandpass(noise, sampleRate, f.hz, f.q);
    // 각 밴드 RMS 를 1 로 맞춘 뒤 가중 — Q·fc 에 따른 에너지 편차 제거(가중치가 곧 스펙트럼).
    let sum = 0;
    for (let i = 0; i < n; i++) sum += band[i] * band[i];
    const g = f.gain / Math.max(1e-9, Math.sqrt(sum / n));
    for (let i = 0; i < n; i++) x[i] += band[i] * g;
  }
  const air = new Float64Array(noise);
  biquad(air, sampleRate, AIR_LO_HZ, 'hp');
  biquad(air, sampleRate, AIR_HI_HZ, 'lp');
  let airSum = 0;
  for (let i = 0; i < n; i++) airSum += air[i] * air[i];
  const airG = AIR_GAIN / Math.max(1e-9, Math.sqrt(airSum / n));
  for (let i = 0; i < n; i++) x[i] += air[i] * airG;

  // ② 엔벨로프: 어택(t^2 로 차오름) → 유지 → 릴리즈(선형 감쇠 — 발화 앞에서 잦아듦).
  const attack = Math.floor(n * ATTACK_PORTION);
  const release = Math.floor(n * RELEASE_PORTION);
  for (let i = 0; i < attack; i++) x[i] *= (i / attack) ** 2;
  for (let i = 0; i < release; i++) x[n - 1 - i] *= i / release;

  // ③ RMS 1 정규화 → 소프트 클립(과대 피크 완화) → 재정규화.
  //    ⚠️ 재정규화(÷ 클립 후 RMS < 1)가 피크를 도로 키우므로 tanh 만으로는 crest ≤
  //    CREST_LIMIT 이 "보장"되지 않는다(교차검증 Claude 실측 2026-07-20: 20만 시드에서
  //    crest 최대 3.49). 그래서 ④는 상수 가정 대신 "실측 피크"로 스케일을 계산한다.
  normalizeRms(x);
  for (let i = 0; i < n; i++) x[i] = CREST_LIMIT * Math.tanh(x[i] / CREST_LIMIT);
  normalizeRms(x);

  // ④ 목표 RMS = min(관례 음량, 문턱 피크 상한 ÷ 실측 crest). RMS(x)=1 이므로 실측
  //    피크 p 에 대해 출력 피크 = p × target — target ≤ fitPeak/p 이면 피크 ≤ fitPeak 가
  //    "구조적으로" 보장된다(시드·분포 무관).
  const th = Math.min(
    BREATHY_THRESH.cap,
    Math.max(BREATHY_THRESH.floor, stats.peak * BREATHY_THRESH.rel),
  );
  const fitPeak = th * THRESH_MARGIN;
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(x[i]));
  const target = Math.min(stats.rms * 10 ** (BREATH_REL_DB / 20), p > 0 ? fitPeak / p : 0);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = x[i] * target;
  return out;
}

// ── 문단 들숨(재생 단계 쉼용 — gapPlayer 가 쉼 WAV 안에 심는다) ──────────
// 쉼이 짧으면 들숨 길이를 그에 맞춰 줄인다 — 고정 길이를 쉼 버퍼에 욱여넣고 자르면
// 릴리즈 엔벨로프가 사라져 절단면 딱 소리가 난다(교차검증 Gemini 지적 2026-07-20:
// 쉼 350~399ms 구간에서 후미 ~50ms 절단). 최소 길이도 안 들어가면 null(무음 쉼 유지).
// 앞 여유가 30ms 로 충분한 이유: 직전 문장 파일 꼬리에 320ms 무음(TRAIL_PAD)이 이미
// 구워져 있어 들숨은 어차피 그 뒤에서 시작한다.
const GAP_BREATH_LEAD_MS = 30;
const GAP_BREATH_TAIL_MS = 30;
const GAP_BREATH_MAX_MS = 170;
const GAP_BREATH_MIN_MS = 110;
/** 이 미만의 쉼엔 들숨이 들어가지 않는다(= lead + min + tail). 고배속에선 문단 쉼 자체가
 *  이보다 짧아져 자동 제외 — 별도 배속 게이트 불필요. */
export const GAP_BREATH_MIN_TOTAL_MS = GAP_BREATH_LEAD_MS + GAP_BREATH_MIN_MS + GAP_BREATH_TAIL_MS;
// 대표 발화 레벨(고정): 문장별 실측 RMS 편차가 작아(σ≈1.1dB, 2026-07-18) 대표값으로
// 충분하다. peak 0.55 는 하이라이트 문턱 클램프(makeBreathSamples ④)가 여기서는 물리지
// 않게 하는 값 — 쉼 재생엔 정렬이 없으므로 관례 음량(BREATH_REL_DB)이 그대로 적용된다.
const GAP_SPEECH_STATS: SpeechStats = { rms: 0.07, peak: 0.55 };

/** 쉼(gapMs) 안에 들어갈 문단 들숨. 안 들어가면 null. 결정론(같은 gapMs = 같은 파형). */
export function makeGapBreath(
  gapMs: number,
  sampleRate: number,
): { leadMs: number; samples: number[] } | null {
  const dur = Math.min(GAP_BREATH_MAX_MS, gapMs - GAP_BREATH_LEAD_MS - GAP_BREATH_TAIL_MS);
  if (dur < GAP_BREATH_MIN_MS) return null;
  return {
    leadMs: GAP_BREATH_LEAD_MS,
    samples: makeBreathSamples(sampleRate, dur, GAP_SPEECH_STATS, 'paragraph'),
  };
}

function normalizeRms(x: Float64Array): void {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const rms = Math.sqrt(sum / x.length);
  if (rms <= 0) return;
  for (let i = 0; i < x.length; i++) x[i] /= rms;
}
