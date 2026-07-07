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

// 무음 창 연속 구간(최소 길이 필터 없음) — 압축·앞뒤 트림·단어 정렬(align.ts)의 공용 기반.
export function quietRuns(samples: ArrayLike<number>, sampleRate: number): QuietRun[] {
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
  const thresh = Math.min(THRESH_CAP, Math.max(THRESH_FLOOR, globalPeak * THRESH_REL));

  const runs: QuietRun[] = [];
  let runStart = -1;
  for (let w = 0; w <= nWin; w++) {
    const quiet = w < nWin && winPeak[w] <= thresh;
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
const LEAD_PAD_MS = 40; // 트림 후 남길 문장 머리 여유
const TRAIL_PAD_MS = 120; // 트림 후 남길 문장 꼬리 여유(문장 간 최소 숨)

export function edgeSilenceCuts(samples: ArrayLike<number>, sampleRate: number): SilenceCut[] {
  const n = samples.length;
  const runs = quietRuns(samples, sampleRate);
  if (!runs.length) return [];
  const ms = (v: number) => (v * 1000) / sampleRate;
  const cuts: SilenceCut[] = [];
  const first = runs[0];
  if (first.s === 0 && ms(first.e - first.s) >= EDGE_MIN_MS + LEAD_PAD_MS && first.e < n) {
    cuts.push({ start: 0, end: first.e - Math.round((sampleRate * LEAD_PAD_MS) / 1000) });
  }
  const last = runs[runs.length - 1];
  if (last.e === n && ms(last.e - last.s) >= EDGE_MIN_MS + TRAIL_PAD_MS && last.s > 0) {
    cuts.push({ start: last.s + Math.round((sampleRate * TRAIL_PAD_MS) / 1000), end: n });
  }
  return cuts;
}

// 앞뒤 무음 트림 적용(≤3× 경로 — 속도 보상 없음: 죽은 공기 제거일 뿐 말소리 속도는 불변).
export function trimEdgeSilence(samples: ArrayLike<number>, sampleRate: number): number[] {
  const cuts = edgeSilenceCuts(samples, sampleRate);
  if (!cuts.length) return Array.from(samples);
  const n = samples.length;
  let removed = 0;
  for (const c of cuts) removed += c.end - c.start;
  if (removed >= n) return Array.from(samples); // 전체 무음 — 원본 유지(compressSilence 와 동일 방침)
  const out = new Array<number>(n - removed);
  let w = 0;
  let pos = 0;
  for (const c of cuts) {
    for (let i = pos; i < c.start; i++) out[w++] = samples[i];
    pos = c.end;
  }
  for (let i = pos; i < n; i++) out[w++] = samples[i];
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
