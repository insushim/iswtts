// sherpa(Supertonic) 배속 매핑(순수 함수 — 테스트 대상).
//
// 2026-07-06 Whisper CER 실측(맥 sherpa-onnx python 1.12.34 + 동일 int8 모델):
// - 모델 speed 는 음소 길이를 기계적으로 1/N 압축 → 1.5=CER26%, 2.0=72%, 3.0=82%
//   ("2배속부터 씹힘, 3배속은 아예 생략" 사용자 보고의 실체). 고배속 합성 불가 모델.
// - 자연속도(1.0) 합성 + 재생속도(피치보정 타임스트레치)는 온전: 2.0=CER10%(기준선 동급),
//   3.0=18% — 44.1kHz 청정 WAV 라 스트레치가 잘 먹는다(Edge 24kHz mp3 보다 우수).
// → 1× 초과는 전부 재생속도가 담당, 모델 speed 는 저속(≤1×, 자연스러운 느린 합성)에만 사용.
// 재생속도 3.0 은 expo-audio Android 하드클램프(2.0)를 patches/expo-audio 로 3.0 까지 해제해 달성.

export const SHERPA_PLAYBACK_MAX = 3.0; // 실효 총배속 상한(3× 초과는 클램프 or 시스템 전환 옵션)

// 모델이 분담할 배수 — 저속만. 1× 초과에 모델 speed 를 쓰면 음소 붕괴(CER 실측).
export function sherpaModelSpeed(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  return Math.min(1, Math.max(0.5, r));
}

// 재생속도가 분담할 배수(1× 초과 전부).
export function sherpaPlaybackRate(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  return Math.max(1, Math.min(SHERPA_PLAYBACK_MAX, r));
}
