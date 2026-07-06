// Edge 배속 분담(순수 함수 — 테스트 대상).
//
// 2026-07-06 Whisper CER 실측(전사 정확도, scratchpad 실험)으로 확정한 물리 한계:
// - Edge SSML rate는 +100%(2.0×)에서 서비스가 포화 클램프(+150%·+200% 요청 = +100%와 동일 길이).
// - Sonic(재생속도 타임스트레치)은 자연속도 소스엔 2.0×까지 온전(CER 4%)하지만, 이미 빨라진
//   합성음에 겹치면 파괴적(2×소스+1.25=12%, +50%소스+2.0=40%, 2×소스+1.5=38% — 통음절 소실).
// → Edge가 깨끗하게 낼 수 있는 총배속 상한 = 2.0×. 그 안에서는 기하평균 분담(√rate씩)이
//   실측 최저 CER(2×에서 2%). 2× 초과 요청은 여기서 2×로 클램프되고, 상위(player.ts)가
//   시스템 TTS 자동 전환으로 처리한다(시스템 엔진은 고배속이 또렷 — 사용자 실기기 확인).
// 저속(<1×)은 신경망 합성이 더 자연스러워 SSML에 맡긴다.

export const EDGE_MAX_RATE = 2.0; // Edge 품질 보장 총배속 상한(초과분은 엔진 전환으로 해결)
export const SSML_MAX_MULT = 2; // Edge SSML rate 실효 상한(+100% 포화 실측)
export const PLAYBACK_MAX = 2.0; // expo-audio Android 재생속도 상한(coerceIn 0.1..2.0)

// SSML이 분담할 배수(√rate — 총배속은 EDGE_MAX_RATE로 클램프).
export function edgeSsmlMult(rate?: number): number {
  const raw = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  const r = Math.min(EDGE_MAX_RATE, raw);
  if (r <= 1) return Math.max(0.5, r);
  const playback = Math.min(PLAYBACK_MAX, Math.sqrt(r));
  return Math.min(SSML_MAX_MULT, r / playback);
}

export function edgeSsmlRatePct(rate?: number): string {
  const pct = Math.round((edgeSsmlMult(rate) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

// 재생속도가 분담할 배수(전체 ÷ SSML 몫 — 총배속은 EDGE_MAX_RATE로 클램프).
export function edgePlaybackRate(rate?: number): number {
  const raw = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  const r = Math.min(EDGE_MAX_RATE, raw);
  if (r <= 1) return 1;
  return Math.max(0.5, Math.min(PLAYBACK_MAX, r / edgeSsmlMult(r)));
}
