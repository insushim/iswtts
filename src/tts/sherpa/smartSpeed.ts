// 스마트 스피드: 합성 오디오의 긴 쉼(무음)을 압축해 "왜곡 0 배속"을 버는 순수 함수.
// (오디오북 앱들의 검증된 기법 — Overcast Smart Speed 계열.)
//
// 왜: 초고배속(>3×)에서 재생 스트레치는 3.0 근처가 물리 한계(3.0=CER18% → 3.5=62% 절벽).
// 쉼을 먼저 잘라내면 그만큼 스트레치가 감당할 몫이 줄어 같은 설정 배속에서 더 또렷하다.
// 적용 여부 정책(>3×만)은 rate.ts, 여기는 신호처리만.
//
// 설계: 10ms 창 피크로 무음 판정 → 160ms 이상 이어진 쉼만 대상 → 가운데를 잘라내고
// 말소리와 맞닿은 양끝은 남긴다(어택/여운 보존, 쉼 자체는 짧게나마 유지해 운율 보존).
// 문장 앞뒤 무음은 말소리 쪽 한쪽만 남기고 정리(문장 간 진행도 빨라짐).

const HOP_MS = 10; // 판정 창(피크 측정 단위)
const MIN_PAUSE_MS = 160; // 이보다 짧은 쉼은 건드리지 않음(단어 사이 미세 간격 보존)
// 압축 후 말소리 쪽에 남기는 쉼(내부 쉼은 양쪽 40ms = 총 80ms).
// ⚠️ align.ts PAUSE_MIN_MS(120)와 결합: 압축된 쉼(80ms)이 그 임계 미만이어야 >3× 정렬이
// 균등 분배로 폴백한다(의도) — 이 값을 키우면 align.ts 주석과 함께 재검토할 것.
const KEEP_SIDE_MS = 40;
// 무음 문턱: 전체 피크 대비 2%(−34dB), 바닥 0.004(정규화 안 된 저음량 출력 대비),
// 상한 0.02(과대 피크로 문턱이 치솟아 말소리를 무음 취급하는 것 방지).
const THRESH_FLOOR = 0.004;
const THRESH_CAP = 0.02;
const THRESH_REL = 0.02;

export type SilenceCut = { start: number; end: number }; // 원본 샘플 인덱스 [start, end)
export type QuietRun = { s: number; e: number }; // 무음 창 연속 구간(샘플 인덱스, 최소 길이 필터 없음)

export type CompressedAudio = {
  samples: number[];
  /** 원본길이 ÷ 압축길이(≥1). 재생 스트레치를 이만큼 덜어낸다(rate.ts). */
  factor: number;
  /** 원본 타임스탬프(ms) → 압축 후 ms. 단조 증가. (하이라이트는 v1.13.0부터 align.ts 가
   *  압축 후 샘플에서 직접 계산 — 이 매핑은 외부 타임스탬프 보정이 필요한 경우용/테스트 스펙.) */
  mapMs: (ms: number) => number;
};

// 무음 판정 문턱 오버라이드(단어 정렬의 "숨소리 모드"용 — 트림·압축 경로는 기본값 고정).
export type QuietThresh = { rel: number; floor: number; cap: number };

// 무음 창 연속 구간(최소 길이 필터 없음) — 압축·앞뒤 트림·단어 정렬(align.ts)의 공용 기반.
export function quietRuns(
  samples: ArrayLike<number>,
  sampleRate: number,
  thresh?: QuietThresh,
): QuietRun[] {
  const n = samples.length;
  const hop = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
  const nWin = Math.ceil(n / hop);
  if (nWin === 0) return [];

  const winPeak = new Float64Array(nWin);
  let globalPeak = 0;
  for (let w = 0; w < nWin; w++) {
    let p = 0;
    const end = Math.min(n, (w + 1) * hop);
    for (let i = w * hop; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > p) p = a;
    }
    winPeak[w] = p;
    if (p > globalPeak) globalPeak = p;
  }
  const t = thresh ?? { rel: THRESH_REL, floor: THRESH_FLOOR, cap: THRESH_CAP };
  const th = Math.min(t.cap, Math.max(t.floor, globalPeak * t.rel));

  const runs: QuietRun[] = [];
  let runStart = -1;
  for (let w = 0; w <= nWin; w++) {
    const quiet = w < nWin && winPeak[w] <= th;
    if (quiet && runStart < 0) runStart = w;
    if (!quiet && runStart >= 0) {
      runs.push({ s: runStart * hop, e: Math.min(n, w * hop) });
      runStart = -1;
    }
  }
  return runs;
}

// 잘라낼 구간 계산(테스트 대상 핵심 로직 — 샘플 복사와 분리).
export function findSilenceCuts(samples: ArrayLike<number>, sampleRate: number): SilenceCut[] {
  const n = samples.length;
  const minPause = (sampleRate * MIN_PAUSE_MS) / 1000;
  const keepSide = Math.round((sampleRate * KEEP_SIDE_MS) / 1000);
  const cuts: SilenceCut[] = [];
  for (const r of quietRuns(samples, sampleRate)) {
    if (r.e - r.s < minPause) continue;
    const atStart = r.s === 0;
    const atEnd = r.e === n;
    // 말소리와 맞닿은 쪽만 남긴다 — 앞뒤 무음은 한쪽, 내부 쉼은 양쪽.
    const cutS = r.s + (atStart ? 0 : keepSide);
    const cutE = r.e - (atEnd ? 0 : keepSide);
    if (cutE > cutS) cuts.push({ start: cutS, end: cutE });
  }
  return cuts;
}

// 문장 앞뒤 무음만 제거(내부 쉼·말소리 불변 — 전 배속 공용).
// Supertonic 은 문장마다 앞 ~0.4s·뒤 ~0.5s 무음을 박아 생성(실측 2026-07-07) — 문장 전환
// 시 "죽은 공기" ~0.9s 의 주범. 자연스러운 문장 간 숨은 패드로 남긴다.
const EDGE_MIN_MS = 80; // 이보다 짧은 앞뒤 무음은 그대로(오탐 방지)
export const LEAD_PAD_MS = 40; // 트림 후 남길 문장 머리 여유
// 짧은 문장("똑똑!"·"응." 같은 2~3음절)만 쓰는 넉넉한 머리 여유(v1.27.0). 사용자 보고
// 2026-07-21 "짧은 말이 씹힌다 / '똑똑!' 같은 건 아예 안 읽힌다"(2배속). 합성 자체는 온전
// (실측 short_probe: '똑똑!'은 0.45s 발화가 정상 생성) — 남은 설명은 재생 시작 직후의
// 손실(플레이어 준비·setPlaybackRate 반영 지연으로 앞 수십 ms 가 먹히는 동작)이다. 긴
// 문장에선 40ms 여유로 가려지지만 2음절 감탄사에선 그 손실이 곧 첫 음절이라 통째로
// 사라진 것처럼 들린다. 짧은 문장에만 머리 여유를 키워 손실을 무음으로 흡수한다
// (긴 문장의 리듬은 그대로 — 문장 전환 텀이 늘어나지 않는다).
// 부수 효과(의도된 이점): 140ms 는 align.ts 의 쉼 최소길이(PAUSE_MIN_MS 120)보다 길어
// 하이라이트 정렬이 이 머리 패드를 "쉼"으로 분류해 발화 구간에서 제외한다 — 구 40ms 는
// 그 아래라 첫 단어 구간에 섞여 들어갔다. 값을 120 밑으로 내리면 이 성질이 사라진다.
export const SHORT_LEAD_PAD_MS = 140;
/** "짧은 문장" 판정 기준(합성 입력 글자 수). 8자면 "똑똑!"·"응."·"왜 그래?" 가 들어오고
 *  일반 서술문은 들어오지 않는다. */
export const SHORT_SENTENCE_CHARS = 8;

// 배속 비례 상한 — SHORT_LEAD_PAD_MS 가 흡수하는 재생 시작 손실은 "실시간" 현상인데 파일에
// 굽는 무음은 재생 스트레치로 배속만큼 줄어든다(2.5×면 140→실 56ms — 사용자 보고 2026-07-23
// "2.5×에서 '예!' 같은 짧은 말이 여전히 통째로 안 들린다"의 남은 설명). 배속을 곱해 실시간
// 흡수량을 ≈140ms 로 일정하게 유지한다. 상한 3 = 스트레치 온전 구간(SONIC_FIRST_MAX)과 일치
// (>3×는 compressSilence 경로라 이 패드 자체가 무관).
// ⚠️ 패드가 파일에 구워지므로 이 값은 캐시 키에 포함돼야 한다(SherpaTtsEngine.keyOf —
// 짧은 문장만 배속 구간별로 키가 갈리고, 일반 문장은 종전대로 배속 무관 단일 키).
const LEAD_PAD_RATE_MAX = 3;

/**
 * 이 발화에 쓸 머리 무음 여유(ms). 짧은 문장만 넉넉하게(SHORT_LEAD_PAD_MS 주석) + 배속
 * 비례(LEAD_PAD_RATE_MAX 주석).
 * ⚠️ 판정은 "정규화 후"(합성에 실제로 들어가는) 텍스트 기준 — 원문 기준이 아니어도 캐시
 * 키=오디오 정합은 유지된다(정규화는 원문·언어의 순수 함수이고 그 둘이 이미 키에 있다).
 */
/** 짧은 문장 패드의 배속 버킷(0.5 단위 올림 양자화). 패드는 캐시 키에 들어가므로 배속의
 *  연속 함수면 0.1 눈금마다 짧은 문장 키가 전부 갈려 배속 미세조정 때마다 캐시가 헛돈다 —
 *  구간을 5개로 묶는다. 올림이라 흡수량은 항상 목표(≈140ms 실시간) 이상.
 *  라이브 배속 변경의 스테일 큐 판정(player.applyRate)도 이 버킷을 비교한다 — 버킷이
 *  바뀌면 짧은 문장 캐시 키가 갈려, 미리 채운 큐를 새 배속으로 다시 채워야 한다. */
export function leadPadRateBucket(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1;
  return Math.ceil(Math.min(LEAD_PAD_RATE_MAX, Math.max(1, r)) * 2) / 2;
}

export function leadPadMsFor(spokenText: string, rate?: number): number {
  if (spokenText.trim().length > SHORT_SENTENCE_CHARS) return LEAD_PAD_MS;
  return Math.round(SHORT_LEAD_PAD_MS * leadPadRateBucket(rate));
}

// 트림 후 남길 문장 꼬리 여유 = 문장 간 숨. 320ms(2026-07-18, 구 120): 1× 낭독이 사람
// 낭독처럼 문장 사이에서 숨을 고르도록 — 파일에 굽는 무음이라 재생 스트레치로 자동
// 비례(2×에선 160ms), >3× 스마트 스피드는 compressSilence 경로라 이 패드와 무관(빠른
// 배속의 밀도는 그대로). 캐시 파일이 배속 무관 유효한 것도 이 방식 덕(레이트별 분기 금지).
export const TRAIL_PAD_MS = 320;
// 절단면 페이드: 트림 컷 지점의 파형은 문턱(≈−44dB) 직하라 0 으로 뚝 끊기면 조용한 절 끝에서
// 미세한 틱으로 들릴 수 있다(1× "씹힘" 조사 2026-07-18). 컷이 실제로 일어난 가장자리에만
// 짧은 선형 페이드를 입힌다. 무음 구간 위라 말소리 훼손 없음.
export const EDGE_FADE_MS = 8;

export function edgeSilenceCuts(
  samples: ArrayLike<number>,
  sampleRate: number,
  leadPadMs: number = LEAD_PAD_MS,
  trailPadMs: number = TRAIL_PAD_MS,
): SilenceCut[] {
  const n = samples.length;
  const runs = quietRuns(samples, sampleRate);
  if (!runs.length) return [];
  const ms = (v: number) => (v * 1000) / sampleRate;
  const cuts: SilenceCut[] = [];
  const first = runs[0];
  if (first.s === 0 && ms(first.e - first.s) >= EDGE_MIN_MS + leadPadMs && first.e < n) {
    cuts.push({ start: 0, end: first.e - Math.round((sampleRate * leadPadMs) / 1000) });
  }
  const last = runs[runs.length - 1];
  if (last.e === n && ms(last.e - last.s) >= EDGE_MIN_MS + trailPadMs && last.s > 0) {
    cuts.push({ start: last.s + Math.round((sampleRate * trailPadMs) / 1000), end: n });
  }
  return cuts;
}

// 앞뒤 무음 트림 적용(≤3× 경로 — 속도 보상 없음: 죽은 공기 제거일 뿐 말소리 속도는 불변).
//
// 컷은 앞·뒤 최대 2개뿐이라 결과는 언제나 연속 구간 하나 = slice 한 번. 요소별 복사 루프를
// 쓰지 않는 이유(2026-07-13): 문장 하나가 44.1kHz × 5초 ≈ 25만 샘플이고, 이 함수는 재생
// 중에 선행 합성마다 돌아 JS 스레드를 잡는다. 그 점유가 오디오·자막을 밀어낸다.
export function trimEdgeSilence(
  samples: ArrayLike<number>,
  sampleRate: number,
  leadPadMs?: number,
  trailPadMs?: number,
  fadeMs = 0,
): number[] {
  const n = samples.length;
  const cuts = edgeSilenceCuts(samples, sampleRate, leadPadMs, trailPadMs);
  let start = 0;
  let end = n;
  for (const c of cuts) {
    if (c.start === 0) start = Math.max(start, c.end); // 머리 무음
    if (c.end === n) end = Math.min(end, c.start); // 꼬리 무음
  }
  // 전체 무음(합성 실패 성격) — 빈 오디오를 만들지 말고 원본 유지(compressSilence 와 동일 방침).
  if (end <= start) return Array.from(samples);
  if (start === 0 && end === n) return Array.from(samples);
  const out = Array.prototype.slice.call(samples, start, end) as number[];
  // 절단면 페이드(EDGE_FADE_MS 주석 참조) — 컷이 일어난 가장자리에만. 잔여가 페이드 2개보다
  // 짧으면 앞뒤 페이드가 겹쳐 이중 감쇠되므로 절반으로 클램프(교차검증 지적 2026-07-18).
  if (fadeMs > 0) {
    const f = Math.min(Math.floor(out.length / 2), Math.round((sampleRate * fadeMs) / 1000));
    if (start > 0) for (let i = 0; i < f; i++) out[i] *= i / f;
    if (end < n) for (let i = 0; i < f; i++) out[out.length - 1 - i] *= i / f;
  }
  return out;
}

// ── 꼬리 웅얼거림 게이트(v1.27.3) ─────────────────────────────────
// 이 팩의 대사 화자(sid 1·6)는 말이 끝난 뒤 40~100ms 동안 저레벨 유성 잔향(피크의 13~19%)을
// 남긴다 — 실측 2026-07-24(ell6/tailgate_probe, 지문 화자 sid 0 은 0~40ms). 사용자가 반복
// 보고한 "문장 끝의 '드' 같은 불필요한 발음"의 남은 후보다(v1.27.1에서 고친 따옴표·잔존
// 마침표 잔향과는 다른, 화자 고유의 날숨).
// 규칙: **마지막 강프레임(피크의 30% 초과) 뒤**만 본다 — 발화 본체는 어떤 경우에도 건드리지
// 않는다. 그 뒤 구간의 최대 레벨이 피크의 25%를 넘으면(= 진짜 여린 말끝) 그대로 두고,
// 아니면 40ms 페이드로 눕힌다. Whisper 전사는 게이트 전후가 동일했다(말끝 삭제 아님).
const TAIL_FRAME_MS = 20;
const TAIL_STRONG_REL = 0.3;
const TAIL_GATE_REL = 0.25;
const TAIL_FADE_MS = 40;
// 이보다 짧은 꼬리는 건드리지 않는다 — 종성 파열음(ㅂ·ㄷ·ㄱ)의 개방 버스트가 딱 이 길이대라
// 무차별 페이드는 말끝 자음을 깎는다(교차검증 codex 경고). 화자 날숨은 60ms 이상 이어진다.
const TAIL_MIN_MURMUR_MS = 60;

export function gateTailMurmur(samples: number[], sampleRate: number): number[] {
  const win = Math.max(1, Math.round((sampleRate * TAIL_FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / win);
  if (frames < 3) return samples;
  const rms = new Array<number>(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * win;
    for (let i = 0; i < win; i++) sum += samples[base + i] * samples[base + i];
    rms[f] = Math.sqrt(sum / win);
    if (rms[f] > peak) peak = rms[f];
  }
  if (peak <= 0) return samples;
  let lastStrong = -1;
  for (let f = frames - 1; f >= 0; f--) {
    if (rms[f] > peak * TAIL_STRONG_REL) {
      lastStrong = f;
      break;
    }
  }
  if (lastStrong < 0 || lastStrong >= frames - 1) return samples;
  let murmurFrames = 0;
  for (let f = lastStrong + 1; f < frames; f++) {
    if (rms[f] > peak * TAIL_GATE_REL) return samples; // 진짜 말끝이 이어진다
    // 무음이 아니라 "들리는" 잔향만 센다(무음 꼬리는 원래 있는 것).
    if (rms[f] > peak * 0.02) murmurFrames = f - lastStrong;
  }
  if (murmurFrames * TAIL_FRAME_MS < TAIL_MIN_MURMUR_MS) return samples;
  const cut = (lastStrong + 1) * win;
  const fade = Math.min(samples.length - cut, Math.round((sampleRate * TAIL_FADE_MS) / 1000));
  const out = samples;
  for (let i = 0; i < fade; i++) out[cut + i] *= 1 - i / fade;
  for (let i = cut + fade; i < out.length; i++) out[i] = 0;
  return out;
}

export function compressSilence(samples: ArrayLike<number>, sampleRate: number): CompressedAudio {
  const n = samples.length;
  const cuts = findSilenceCuts(samples, sampleRate);
  if (!cuts.length) {
    return { samples: Array.from(samples), factor: 1, mapMs: (ms) => ms };
  }

  // 전체가 무음인 극단 케이스(합성 실패 성격) — 빈 오디오를 만들지 말고 원본 유지.
  let removedTotal = 0;
  for (const c of cuts) removedTotal += c.end - c.start;
  const outLen = n - removedTotal;
  if (outLen <= 0) {
    return { samples: Array.from(samples), factor: 1, mapMs: (ms) => ms };
  }

  // 사전 할당(수십만 샘플 push 증가 방지 — 재생 중 prefetch 합성이 JS 스레드를 점유하는
  // 시간을 줄여 단어 하이라이트 폴링 지연을 막는다).
  const out = new Array<number>(outLen);
  let w = 0;
  let pos = 0;
  for (const c of cuts) {
    for (let i = pos; i < c.start; i++) out[w++] = samples[i];
    pos = c.end;
  }
  for (let i = pos; i < n; i++) out[w++] = samples[i];

  const factor = n / outLen;

  const mapMs = (ms: number): number => {
    const s = (ms * sampleRate) / 1000;
    let removed = 0;
    for (const c of cuts) {
      if (s <= c.start) break;
      removed += Math.min(s, c.end) - c.start;
    }
    return ((s - removed) * 1000) / sampleRate;
  };

  return { samples: out, factor, mapMs };
}
