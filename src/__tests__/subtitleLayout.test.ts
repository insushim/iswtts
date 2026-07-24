import { subtitleShrink, autoScrollTarget, shouldScroll } from '../lib/subtitleLayout';

// 자막 레이아웃 스펙(v1.27.3) — 한 화면을 넘는 문장이 잘리지 않게.

describe('subtitleShrink', () => {
  test('짧은 문장은 원 크기, 길수록 단계적으로 축소(하한 0.85 — 접근성 배율 존중)', () => {
    expect(subtitleShrink(30)).toBe(1);
    expect(subtitleShrink(120)).toBe(1);
    expect(subtitleShrink(150)).toBe(0.92);
    expect(subtitleShrink(400)).toBe(0.85);
  });
  test('단조 감소(길어질수록 커지지 않는다)', () => {
    let prev = 1;
    for (let n = 0; n < 400; n += 7) {
      const v = subtitleShrink(n);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('autoScrollTarget', () => {
  const base = { charIndex: 0, charLen: 4, textLen: 200, contentH: 1000, viewH: 400 };
  test('내용이 화면 안에 다 들어오면 스크롤하지 않는다', () => {
    expect(autoScrollTarget({ ...base, contentH: 300 })).toBe(0);
  });
  test('하이라이트가 세로 중앙에 오도록 — 문장 중간이면 중간쯤', () => {
    const y = autoScrollTarget({ ...base, charIndex: 100 });
    expect(y).toBeCloseTo(1000 * 0.51 - 200, 0);
  });
  test('끝까지 가도 내용 밖으로 넘기지 않는다(클램프)', () => {
    expect(autoScrollTarget({ ...base, charIndex: 199 })).toBe(600);
    expect(autoScrollTarget({ ...base, charIndex: 0 })).toBe(0);
  });
  test('경계 입력(빈 문장·미측정 높이)에서도 0', () => {
    expect(autoScrollTarget({ ...base, textLen: 0 })).toBe(0);
    expect(autoScrollTarget({ ...base, viewH: 0 })).toBe(0);
  });
});

describe('shouldScroll', () => {
  test('화면의 25% 미만 차이면 움직이지 않는다(단어마다 흔들림 방지)', () => {
    expect(shouldScroll(0, 50, 400)).toBe(false);
    expect(shouldScroll(0, 120, 400)).toBe(true);
  });
  test('높이가 아주 작아도 최소 문턱 24px 는 지킨다', () => {
    expect(shouldScroll(0, 10, 20)).toBe(false);
    expect(shouldScroll(0, 30, 20)).toBe(true);
  });
});

describe('lineScrollTarget(줄 정보 기반 — 교차검증 codex 권고)', () => {
  const { lineScrollTarget } = require('../lib/subtitleLayout');
  const lines = [
    { text: '첫째 줄입니다 ', y: 0, height: 40 },
    { text: '둘째 줄입니다 ', y: 40, height: 40 },
    { text: '셋째 줄입니다 ', y: 80, height: 40 },
    { text: '넷째 줄입니다', y: 120, height: 40 },
  ];
  const textLen = lines.reduce((n, l) => n + l.text.length, 0);

  test('하이라이트가 있는 줄이 화면 중앙에 오도록', () => {
    // 줄당 8자 → charIndex 20 은 3번째 줄(y 80~120). 중앙 100 − viewH/2 40 = 60
    expect(lineScrollTarget({ lines, charIndex: 20, textLen, contentH: 160, viewH: 80 })).toBe(60);
    // 마지막 줄(charIndex 30)은 클램프되어 스크롤 끝(160−80)
    expect(lineScrollTarget({ lines, charIndex: 30, textLen, contentH: 160, viewH: 80 })).toBe(80);
  });
  test('내용이 화면 안에 다 들어오면 0', () => {
    expect(lineScrollTarget({ lines, charIndex: 30, textLen, contentH: 160, viewH: 200 })).toBe(0);
  });
  test('줄 텍스트 합이 본문 길이와 크게 다르면 신뢰하지 않는다(null → 비례 폴백)', () => {
    expect(lineScrollTarget({ lines, charIndex: 5, textLen: 500, contentH: 160, viewH: 80 })).toBeNull();
  });
  test('줄 정보가 없으면 null', () => {
    expect(lineScrollTarget({ lines: [], charIndex: 0, textLen: 10, contentH: 100, viewH: 50 })).toBeNull();
  });
});

describe('hideNeighbors', () => {
  const { hideNeighbors } = require('../lib/subtitleLayout');
  test('긴 문장에서만 이웃 자막을 감춘다', () => {
    expect(hideNeighbors(60)).toBe(false);
    expect(hideNeighbors(240)).toBe(true);
  });
});
