// 진행 바 위치 ↔ 문장 인덱스 매핑(순수 함수 — 테스트 대상).
//
// 표시와 시킹이 반드시 같은 공식을 써야 한다: v1.14.0 초안에서 표시=(index+1)/len,
// 시킹=round(pct*(len-1))로 달라 "0%로 끌어 놓으면 20%로 튀는" 스냅 버그가 있었다
// (교차검증 2계열 합치 발견, 2026-07-08). 위치 정의 = index/(len-1)
// (0%=첫 문장, 100%=마지막 문장) 하나로 통일한다.

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// 문장 인덱스 → 진행 위치(0..1). 빈 문서=0, 문장 1개=1(그 문장이 곧 끝).
export function indexToPct(index: number, length: number): number {
  if (length <= 0) return 0;
  if (length === 1) return 1;
  return Math.max(0, Math.min(length - 1, index)) / (length - 1);
}

// 진행 위치(0..1) → 문장 인덱스. 항상 [0, length-1] 범위.
export function pctToIndex(pct: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.round(clamp01(pct) * (length - 1))));
}
