// 자막(현재 문장) 레이아웃 계산(순수 함수 — 화면은 이 결과를 그리기만 한다).
//
// 왜: 대사 한 덩어리가 한 문장이 되는 소설에서는 현재 문장이 240자를 넘기도 한다. 지금까지
// 자막 영역은 flex 중앙 정렬 고정이라 그런 문장이 위아래로 흘러넘쳐 상단바·진행바를 덮고
// 잘렸다(사용자 보고 2026-07-24 스크린샷). 해결은 두 축:
//   ① 길이에 따라 글자 크기를 단계적으로 줄인다(일정 길이까지는 스크롤 없이 다 보이게).
//   ② 그래도 넘치면 스크롤 영역 안에서 하이라이트를 따라 자동으로 내려간다.

/** 문장 길이별 자막 축소 비율. 단계형(연속 함수가 아님) — 글자 수가 한 자 늘 때마다 크기가
 *  미세하게 변하면 매 문장 레이아웃이 들썩인다.
 *  ⚠️ 축소는 **보조 수단**이다(교차검증 codex): 사용자의 글씨 크기 설정(fontScale)을 크게
 *  거스르면 접근성 설정이 무의미해지므로 최대 15%까지만 줄인다. 나머지는 스크롤이 맡는다. */
export function subtitleShrink(len: number): number {
  if (len > 200) return 0.85;
  if (len > 120) return 0.92;
  return 1;
}

/** 이 문장은 이웃 자막(이전·다음)을 숨기고 자리를 다 쓸 만큼 긴가. */
export function hideNeighbors(len: number): boolean {
  return len > 120;
}

/**
 * 하이라이트를 따라갈 스크롤 위치(px). RN 은 중첩 Text 조각의 픽셀 위치를 주지 않으므로
 * **글자 인덱스 비례**로 추정한다 — 줄바꿈이 균일한 본문에서는 충분히 정확하고, 빗나가도
 * 사용자가 손으로 스크롤할 수 있다.
 * @returns 목표 y. 넘칠 것이 없으면(내용이 화면 안에 다 들어오면) 0.
 */
export function autoScrollTarget(args: {
  charIndex: number;
  charLen: number;
  textLen: number;
  contentH: number;
  viewH: number;
}): number {
  const { charIndex, charLen, textLen, contentH, viewH } = args;
  const over = contentH - viewH;
  if (!(over > 0) || !(textLen > 0) || !(viewH > 0)) return 0;
  const ratio = Math.min(1, Math.max(0, (charIndex + charLen / 2) / textLen));
  // 하이라이트가 화면 세로 중앙에 오도록. 위·아래 끝에서는 잘리지 않게 클램프.
  return Math.min(over, Math.max(0, ratio * contentH - viewH / 2));
}

/** RN Text 의 onTextLayout 이 준 줄 정보(필요한 필드만). */
export type SubtitleLine = { text: string; y: number; height: number };

/**
 * 줄 정보가 있을 때의 정확한 스크롤 목표 — 하이라이트가 "몇 번째 줄"에 있는지로 계산한다.
 * 글자 비례 추정(autoScrollTarget)은 줄마다 채워진 정도가 달라 어긋날 수 있어서, 줄 정보를
 * 받을 수 있으면 이쪽이 우선이다(교차검증 codex 권고).
 * @returns 목표 y. 줄 정보를 신뢰할 수 없으면(글자 수 합이 본문과 크게 다르면) null.
 */
export function lineScrollTarget(args: {
  lines: SubtitleLine[];
  charIndex: number;
  textLen: number;
  contentH: number;
  viewH: number;
}): number | null {
  const { lines, charIndex, textLen, contentH, viewH } = args;
  if (!lines.length || !(viewH > 0)) return null;
  const sum = lines.reduce((n, l) => n + (l.text ? l.text.length : 0), 0);
  // 줄 텍스트 합이 본문과 크게 다르면(플랫폼별 개행·공백 처리 차이) 신뢰하지 않는다.
  if (!(sum > 0) || Math.abs(sum - textLen) > Math.max(4, textLen * 0.1)) return null;
  const over = contentH - viewH;
  if (!(over > 0)) return 0;
  let acc = 0;
  for (const l of lines) {
    const len = l.text ? l.text.length : 0;
    if (charIndex < acc + len || l === lines[lines.length - 1]) {
      const center = l.y + l.height / 2;
      return Math.min(over, Math.max(0, center - viewH / 2));
    }
    acc += len;
  }
  return 0;
}

/** 지금 위치에서 목표까지 "움직일 만한가" — 단어마다 몇 px 씩 흔들리면 읽기가 어지럽다.
 *  화면 높이의 25% 이상 벌어졌을 때만 한 번에 움직인다(맨 끝 도달은 예외 없이 허용). */
export function shouldScroll(current: number, target: number, viewH: number): boolean {
  return Math.abs(target - current) >= Math.max(24, viewH * 0.25);
}
