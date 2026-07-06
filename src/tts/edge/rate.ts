// Edge 배속 분담(순수 함수 — 테스트 대상).
//
// 두 배속 축은 각자 극단에서 망가진다(실사용 2회 보고 + 에뮬레이터 실측으로 확정):
// - SSML rate(신경망 합성 배속): +100%부터 사람이 빨리 말하듯 음절을 뭉갬(v1.6.2 "씹힘").
// - 재생속도(Media3 Sonic 타임스트레치, 피치 보정): 상한 2.0× 부근에서 스트레치 아티팩트로
//   구간이 뭉개짐(v1.7.0 "생략" — 타임라인 자체는 연속·완주를 에뮬레이터로 실측, 남는 원인은
//   Sonic 출력 품질뿐).
// → 기하평균 분담: 두 축이 같은 배수(√rate)를 나눠 맡아 어느 쪽도 극단에 가지 않게 한다.
//   2× = 합성 1.41(+41%) × 재생 1.41 / 3× = 1.73 × 1.73 / 4×+ = 재생 2.0 상한, 나머지 SSML.
// 저속(<1×)은 신경망 합성이 더 자연스러워 SSML에 맡긴다.
// 실효 상한 = SSML 3× × 재생 2× = 6×.

export const SSML_MAX_MULT = 3; // Edge SSML rate 안전 상한
export const PLAYBACK_MAX = 2.0; // expo-audio Android 재생속도 상한

// SSML이 분담할 배수(√rate, 재생속도 상한 초과분은 SSML이 흡수).
export function edgeSsmlMult(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r <= 1) return Math.max(0.5, r);
  const playback = Math.min(PLAYBACK_MAX, Math.sqrt(r));
  return Math.min(SSML_MAX_MULT, r / playback);
}

export function edgeSsmlRatePct(rate?: number): string {
  const pct = Math.round((edgeSsmlMult(rate) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

// 재생속도가 분담할 배수(전체 ÷ SSML 몫).
export function edgePlaybackRate(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r <= 1) return 1;
  return Math.max(0.5, Math.min(PLAYBACK_MAX, r / edgeSsmlMult(r)));
}
