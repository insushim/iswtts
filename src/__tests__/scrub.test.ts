import { clamp01, indexToPct, pctToIndex } from '../lib/scrub';

describe('scrub 매핑', () => {
  test('clamp01: 범위 밖 값을 0..1로', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.37)).toBe(0.37);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(3)).toBe(1);
  });

  test('경계: 빈 문서·문장 1개', () => {
    expect(indexToPct(0, 0)).toBe(0);
    expect(pctToIndex(0.5, 0)).toBe(0);
    expect(indexToPct(0, 1)).toBe(1);
    expect(pctToIndex(0, 1)).toBe(0);
    expect(pctToIndex(1, 1)).toBe(0);
  });

  test('양 끝점: 0%=첫 문장, 100%=마지막 문장 (표시·시킹 동일 공식)', () => {
    expect(indexToPct(0, 5)).toBe(0);
    expect(indexToPct(4, 5)).toBe(1);
    expect(pctToIndex(0, 5)).toBe(0);
    expect(pctToIndex(1, 5)).toBe(4);
  });

  test('스냅 버그 회귀: 0%로 놓았을 때 표시 위치도 0% (v1.14.0 초안 버그)', () => {
    const len = 5;
    const seeked = pctToIndex(0, len);
    expect(indexToPct(seeked, len)).toBe(0); // 초안 공식에선 0.2로 튀었다
  });

  test('왕복 불변식: pctToIndex(indexToPct(i)) === i', () => {
    for (const len of [2, 3, 5, 100, 1234]) {
      for (const i of [0, 1, Math.floor(len / 2), len - 2, len - 1]) {
        if (i < 0 || i >= len) continue;
        expect(pctToIndex(indexToPct(i, len), len)).toBe(i);
      }
    }
  });

  test('시킹 인덱스는 항상 유효 범위', () => {
    for (const pct of [-1, 0, 0.001, 0.5, 0.999, 1, 2]) {
      const i = pctToIndex(pct, 7);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThanOrEqual(6);
    }
  });
});
