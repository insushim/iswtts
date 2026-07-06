// Edge 배속 분담(순수 함수 — 테스트 대상).
//
// 재생속도 우선 매핑: 신경망 합성 배속(SSML rate)은 사람이 빨리 말하듯 음절을
// 뭉개서 +100%(2×)부터 발음이 씹힌다(실사용 보고). 반면 재생속도(피치 보정
// 타임스트레치)는 모든 음소를 보존한 채 시간만 줄인다(오디오북/팟캐스트 표준).
// → ≤2×는 자연속도(1×)로 합성해 재생속도로만 당기고, 2× 초과분만 SSML이 분담.
// 저속(<1×)은 신경망 합성이 더 자연스러워 SSML에 맡긴다.
// 실효 상한 = SSML 3× × 재생 2× = 6×.

export const SSML_MAX_MULT = 3; // Edge SSML rate 안전 상한
export const PLAYBACK_MAX = 2.0; // expo-audio Android 재생속도 상한

// SSML이 분담할 배수. 1× 초과분 중 재생속도(≤2×)로 못 당기는 몫만 가져간다.
export function edgeSsmlMult(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r < 1) return Math.max(0.5, r);
  return Math.min(SSML_MAX_MULT, Math.max(1, r / PLAYBACK_MAX));
}

export function edgeSsmlRatePct(rate?: number): string {
  const pct = Math.round((edgeSsmlMult(rate) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

// 재생속도가 분담할 배수(전체 ÷ SSML 몫).
export function edgePlaybackRate(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  return Math.max(0.5, Math.min(PLAYBACK_MAX, r / edgeSsmlMult(r)));
}
