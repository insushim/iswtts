// Edge 배속 매핑(순수 함수 — 테스트 대상).
//
// 2026-07-06 최종 확정(사용자 청감 + Whisper CER + ffprobe 실측 종합):
// - v1.6.2까지의 원래 방식(배속 전부 SSML 합성, 재생 스트레치 없음)이 사용자 청감에 좋았다
//   ("엣지 3배속은 원래부터 잘나왔어"). 그 "3배속"의 실체 = 서버가 +100%(2.0×)에서 조용히
//   포화 상한한 깨끗한 2× 음성(+150%/+200% 요청 = +100%와 동일 길이, ffprobe 실측).
// - v1.7.x에서 진짜 3×를 만들려고 얹은 재생 스트레치(Media3 Sonic)가 "뭉개짐/생략"의 주범.
//   Whisper CER은 내용 보존만 재서 스트레치 아티팩트에 둔감(청감과 괴리) — 피치 변조된
//   가상 음성(어린이/할머니 등)에서 아티팩트가 가장 크게 들림.
// → 재생 스트레치 완전 제거, 배속은 전부 SSML(서버 포화 상한 2.0× 수용). 진짜 2× 초과가
//   필요한 사용자는 설정의 시스템 음성 전환 옵션(edgeHighSpeedSystemVoice)을 켠다.

export const EDGE_MAX_RATE = 2.0; // Edge 실효 총배속 상한(서버 포화 실측)

// SSML rate 가 배속 전체를 담당. 서버 포화점(+100%) 이상은 요청해도 동일하므로 2.0 에서 클램프.
export function edgeSsmlMult(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  return Math.min(EDGE_MAX_RATE, Math.max(0.5, r));
}

export function edgeSsmlRatePct(rate?: number): string {
  const pct = Math.round((edgeSsmlMult(rate) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

// 재생속도는 항상 1.0 — 스트레치 아티팩트(뭉개짐) 방지를 위해 사용하지 않는다.
// (함수를 남겨두는 이유: EdgeTtsEngine 호출부 계약 유지 + 실험 이력의 정본 기록.)
export function edgePlaybackRate(_rate?: number): number {
  return 1;
}
