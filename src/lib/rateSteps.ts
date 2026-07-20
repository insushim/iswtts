// 배속 눈금(순수 모듈 — PlayerScreen 스테퍼와 SettingsScreen 속도 Row 의 단일 진실원).
// v1.25.1: 1~2× 구간을 0.1 간격으로 세분(사용자 요청 2026-07-20 — 일상 청취 대역이라
// 1.5 다음이 바로 2.0 이면 너무 성기다). 그 밖은 종전 성긴 간격 유지.
// iOS AVSpeech 는 상한 ~2×(2× 초과 무효)라 2×까지만 노출.
// 값은 Math.round(×10)/10 정규화로 생성해 0.1 누적 부동소수 잔재(1.3000000004×)가 표시·
// 저장에 새지 않는다.
import { Platform } from 'react-native';

const FINE_1_TO_2 = Array.from({ length: 11 }, (_, i) => Math.round((1 + i * 0.1) * 10) / 10);
const COARSE_ABOVE_2 = [2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0];

export const RATE_STEPS: number[] =
  Platform.OS === 'ios' ? [0.5, ...FINE_1_TO_2] : [0.5, ...FINE_1_TO_2, ...COARSE_ABOVE_2];

export const RATE_MIN = RATE_STEPS[0];
export const RATE_MAX = RATE_STEPS[RATE_STEPS.length - 1];

// 현재 배속에서 한 눈금 이동(끝에서 멈춤 — 순환 없음: 10×→0.5× 랩이 저속 합성으로 직렬
// 큐를 막던 함정의 재발 방지, PlayerScreen 주석 참조). 눈금 밖 값(구버전 저장값 등)은
// 가장 가까운 다음/이전 눈금에 스냅된다.
export function stepRateValue(rate: number, dir: 1 | -1): number {
  if (dir > 0) return RATE_STEPS.find((s) => s > rate + 0.001) ?? RATE_MAX;
  for (let i = RATE_STEPS.length - 1; i >= 0; i--) {
    if (RATE_STEPS[i] < rate - 0.001) return RATE_STEPS[i];
  }
  return RATE_MIN;
}
