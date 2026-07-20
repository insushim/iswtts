describe('rateSteps — 배속 눈금(v1.25.1: 1~2× 0.1 간격)', () => {
  const { RATE_STEPS, RATE_MIN, RATE_MAX, stepRateValue } = require('../lib/rateSteps');
  test('1~2× 구간은 0.1 간격 11눈금, 부동소수 잔재 없음', () => {
    const fine = RATE_STEPS.filter((r: number) => r >= 1 && r <= 2);
    expect(fine).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]);
  });
  test('오름차순·중복 없음, 끝값', () => {
    const sorted = [...RATE_STEPS].sort((a: number, b: number) => a - b);
    expect(RATE_STEPS).toEqual(sorted);
    expect(new Set(RATE_STEPS).size).toBe(RATE_STEPS.length);
    expect(RATE_MIN).toBe(0.5);
  });
  test('한 눈금 이동: 1.5 → 1.6/1.4, 끝에서 멈춤(순환 없음)', () => {
    expect(stepRateValue(1.5, 1)).toBe(1.6);
    expect(stepRateValue(1.5, -1)).toBe(1.4);
    expect(stepRateValue(RATE_MAX, 1)).toBe(RATE_MAX);
    expect(stepRateValue(RATE_MIN, -1)).toBe(RATE_MIN);
  });
  test('눈금 밖 저장값(구버전 0.75 등)은 인접 눈금으로 스냅', () => {
    expect(stepRateValue(0.75, 1)).toBe(1);
    expect(stepRateValue(0.75, -1)).toBe(0.5);
    expect(stepRateValue(1.25, 1)).toBe(1.3);
    expect(stepRateValue(1.25, -1)).toBe(1.2);
  });
});
