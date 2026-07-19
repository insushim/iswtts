// 단어 하이라이트 타임스탬프 추정(순수 함수 — 테스트 대상).
//
// 왜 자체 계산인가: 라이브러리(react-native-sherpa-onnx)의 subtitles fast 모드는
// "전체 오디오 길이를 글자 수 비례로 나눈 추정치"(timingMode: 'estimated') — 앞뒤 무음
// (~0.9s/문장, 실측 2026-07-07)과 문장 내 쉼까지 발화 시간으로 깔고 계산해 하이라이트가
// 실제 음성과 수백 ms 어긋난다. accurate 모드는 별도 정렬 모델(wav2vec2, 영어 어휘)
// 다운로드가 필요해 부적합.
//
// 방식: 무음 구간(quietRuns, 120ms+)을 제외한 "실제 발화 구간"들 위에만 단어를 글자 수
// 비례로 분배한다 — 쉼 동안 하이라이트가 전진하지 않고, 쉼 직후 단어는 발화 재개 지점에
// 정렬된다. (한국어는 음절 길이가 비교적 균일해 글자 수 비례가 잘 맞는다.)

import { quietRuns, type QuietThresh } from './smartSpeed';

export type WordBoundary = { ms: number; charIndex: number; charLen: number };

// 이보다 긴 무음만 "발화 없음"으로 제외(짧은 폐쇄음 무음은 발화 취급).
// 주의: >3×(스마트 스피드) 경로는 compressSilence 가 내부 쉼을 이미 ~80ms 로 압축한 뒤라
// 이 임계에 걸리지 않아 사실상 균등 분배가 된다 — 의도된 트레이드오프(그 쉼은 재생속도로
// 나누면 실청감 ~30ms 라 정지 표시가 무의미). ≤3× 경로는 내부 쉼이 보존돼 정상 작동.
const PAUSE_MIN_MS = 120;

// 숨소리 모드 무음 문턱: 들숨의 피크는 말소리의 ~4%(실측 2026-07-19: 0.013 vs 0.319)라
// 기본 문턱(2%, cap 0.02)으로는 "발화"로 오인돼 하이라이트가 숨 구간만큼 앞서갔다.
// 문턱을 6%로 올리면 들숨(≥120ms)이 쉼으로 분류돼 하이라이트가 숨에서 멈췄다 재개된다.
// 약한 마찰음이 순간적으로 이 문턱 아래로 내려가도 120ms 미만이라 쉼이 되지 않는다.
// cap 0.05: 고음량 문장(peak→1.0)에서도 들숨(peak 의 ~4%)이 cap 아래에 남아 쉼으로
// 분류된다(cap 0.03 이면 peak>0.75 부터 미검출 — 교차검증 지적 2026-07-19).
const BREATHY_THRESH: QuietThresh = { rel: 0.06, floor: 0.006, cap: 0.05 };

export function estimateWordBoundaries(
  text: string,
  samples: ArrayLike<number>,
  sampleRate: number,
  opts?: { breathy?: boolean },
): WordBoundary[] {
  // 단어(공백 구분)와 문장 내 오프셋. 가중치 = 낱자 수(구두점뿐인 토큰은 소량).
  // 공백 없는 긴 토큰(숫자열·미정제 텍스트)은 4자 단위로 쪼갠다 — 안 쪼개면 그 구간 내내
  // 하이라이트가 한 지점에 멈춘다(이전 라이브러리는 CJK 를 글자 단위 분할했음 — 회귀 방지).
  const MAX_TOKEN_CHARS = 8;
  const PIECE_CHARS = 4;
  const words: Array<{ ci: number; len: number; w: number }> = [];
  const push = (ci: number, token: string) => {
    const letters = (token.match(/[\p{L}\p{N}]/gu) || []).length;
    words.push({ ci, len: token.length, w: Math.max(0.4, letters) });
  };
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const chars = Array.from(m[0]); // 코드포인트 단위(서로게이트 쌍을 쪼개지 않게)
    if (chars.length <= MAX_TOKEN_CHARS) {
      push(m.index, m[0]);
      continue;
    }
    let off = m.index;
    for (let i = 0; i < chars.length; i += PIECE_CHARS) {
      const piece = chars.slice(i, i + PIECE_CHARS).join('');
      push(off, piece);
      off += piece.length;
    }
  }
  const n = samples.length;
  if (!words.length || n === 0 || sampleRate <= 0) return [];

  // 발화 구간 = 긴 무음의 여집합.
  const minPause = (sampleRate * PAUSE_MIN_MS) / 1000;
  const pauses = quietRuns(samples, sampleRate, opts?.breathy ? BREATHY_THRESH : undefined).filter(
    (r) => r.e - r.s >= minPause,
  );
  const speech: Array<{ s: number; e: number }> = [];
  let pos = 0;
  for (const r of pauses) {
    if (r.s > pos) speech.push({ s: pos, e: r.s });
    pos = r.e;
  }
  if (pos < n) speech.push({ s: pos, e: n });
  if (!speech.length) speech.push({ s: 0, e: n }); // 전체 무음 — 균등 분배 폴백

  const voicedTotal = speech.reduce((a, iv) => a + (iv.e - iv.s), 0);
  const totalW = words.reduce((a, w) => a + w.w, 0);

  // 발화축 위치(0..voicedTotal) → 실제 샘플 위치(무음 구간 건너뜀).
  // 구간 끝(=쉼 시작)에 정확히 떨어지는 위치는 다음 발화 구간 시작으로 — 쉼 직후 단어가
  // 쉼이 끝나는 순간 하이라이트되게(엄격 부등호가 그 정렬을 만든다).
  const toSample = (v: number): number => {
    let acc = 0;
    for (const iv of speech) {
      const len = iv.e - iv.s;
      if (v < acc + len) return iv.s + (v - acc);
      acc += len;
    }
    return speech[speech.length - 1].e;
  };

  const out: WordBoundary[] = [];
  let accW = 0;
  for (const w of words) {
    const vStart = (accW / totalW) * voicedTotal;
    out.push({ ms: (toSample(vStart) * 1000) / sampleRate, charIndex: w.ci, charLen: w.len });
    accW += w.w;
  }
  return out;
}
