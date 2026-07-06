// sherpa(Supertonic) 배속 매핑(순수 함수 — 테스트 대상).
//
// 사용자 방침(2026-07-06): 배속 상한 두지 않음 — 설정 배속은 무조건 그 속도로 재생하고
// 품질 판단은 사용자가 한다. 단 같은 속도에서 가장 잘 들리는 분담을 쓴다(Whisper CER 실측):
// - 모델 speed 솔로: 1.2=14%(온전), 1.5=26%, 2.0=72%, 3.0=82%, ≥4.0=전구간 무음.
// - 재생 스트레치(피치보정) 솔로(자연속도 소스): 2.0=10%, 3.0=18%, 3.2=22%, 3.5=62%(절벽).
// - 총 3.2× 초과에서는 "스트레치 3.0 고정 + 초과분 모델"이 순수 스트레치보다 우수
//   (3.6×: 조합38% vs 순수62% / 4.0×: 조합48% vs 순수76%).
// → 분담: 스트레치가 3.0까지 우선 → 초과분은 모델(무음 경계 3.0 클램프) → 9× 초과 잔여는
//   다시 스트레치(하드맥스 10, expo-audio 패치 상한과 일치).
// + 스마트 스피드(v1.11.0): >3×에서는 합성 오디오의 긴 쉼을 먼저 압축(smartSpeed.ts,
//   왜곡 0 배속 f≈1.1~1.3)하고, 그만큼 스트레치를 덜어낸다(실효 스트레치 = 3/f).
//   ≤3×는 미적용 — 사용자가 청감 확정한 소리를 바꾸지 않는다.

export const SHERPA_QUALITY_MAX = 3.2; // 품질 무손상 임계(시스템 음성 전환 옵션의 기준점)
const SONIC_FIRST_MAX = 3.0; // 스트레치 단독 온전 상한
const MODEL_MAX = 3.0; // 모델 speed ≥4.0 = 전 구간 무음(실측) — 하드 경계
const PLAYBACK_HARD_MAX = 10.0; // expo-audio 패치(coerceIn 상한)와 일치

// 모델이 분담할 배수. 저속(≤1×)은 모델 전담, 스트레치 온전 구간(≤3×)은 모델 개입 금지,
// 그 초과분만 모델이 흡수한다.
export function sherpaModelSpeed(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r <= 1) return Math.max(0.5, r);
  if (r <= SONIC_FIRST_MAX) return 1;
  return Math.min(MODEL_MAX, r / SONIC_FIRST_MAX);
}

// 스마트 스피드(무음 압축) 적용 여부 — 스트레치 온전 구간(≤3×)의 확정된 소리는 건드리지
// 않고, 스트레치가 한계(3.0)에 붙는 초고배속에서만 쉼을 압축해 부담을 덜어낸다.
export function sherpaTrimEnabled(rate?: number): boolean {
  return Number.isFinite(rate as number) && (rate as number) > SONIC_FIRST_MAX;
}

// 재생속도가 분담할 배수(전체 ÷ 모델 몫 ÷ 무음압축 몫). trimFactor = 압축으로 이미 번
// 배속(원본길이÷압축길이, 미압축=1). 곱 불변식: 모델 × trimFactor × 재생속도 = 설정 배속.
export function sherpaPlaybackRate(rate?: number, trimFactor: number = 1): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r <= 1) return 1;
  const f = Number.isFinite(trimFactor) && trimFactor >= 1 ? trimFactor : 1;
  // 하한 0.5: 쉼이 극단적으로 많은 문장에서 압축만으로 목표 배속을 넘어선 경우 되레 늦춰
  // 설정 배속을 정확히 지킨다(현실적으론 f<3 이라 거의 항상 >1).
  return Math.max(0.5, Math.min(PLAYBACK_HARD_MAX, r / (sherpaModelSpeed(r) * f)));
}
