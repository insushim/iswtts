import { sherpaModelSpeed, sherpaPlaybackRate } from '../tts/sherpa/rate';

describe('sherpa 배속(상한 없음 — 스트레치 3× 우선, 초과분 모델)', () => {
  test('1× — 둘 다 중립', () => {
    expect(sherpaModelSpeed(1)).toBe(1);
    expect(sherpaPlaybackRate(1)).toBe(1);
  });

  test('설정 배속 무조건 적용 — 곱 = 요청 배속(9×까지), 상한 클램프 없음(핵심 불변식)', () => {
    for (const r of [1.5, 2, 3, 3.6, 4, 5, 6, 9]) {
      expect(sherpaModelSpeed(r) * sherpaPlaybackRate(r)).toBeCloseTo(r, 5);
    }
    // 9× 초과는 모델 무음 경계(3.0) 유지 + 잔여를 스트레치가 흡수
    expect(sherpaModelSpeed(10)).toBe(3);
    expect(sherpaPlaybackRate(10)).toBeCloseTo(10 / 3, 5);
  });

  test('≤3×는 스트레치 전담(모델 개입 금지 — 음소 붕괴 CER 실측 2.0=72%)', () => {
    for (const r of [1.5, 2, 2.5, 3]) {
      expect(sherpaModelSpeed(r)).toBe(1);
      expect(sherpaPlaybackRate(r)).toBe(r);
    }
  });

  test('3× 초과 — 스트레치 3.0 고정, 초과분만 모델(조합이 순수 스트레치보다 우수 실측)', () => {
    expect(sherpaPlaybackRate(4)).toBeCloseTo(3, 5);
    expect(sherpaModelSpeed(4)).toBeCloseTo(4 / 3, 5);
    expect(sherpaModelSpeed(6)).toBeCloseTo(2, 5);
  });

  test('저속(<1×)은 모델 전담', () => {
    expect(sherpaModelSpeed(0.7)).toBe(0.7);
    expect(sherpaModelSpeed(0.3)).toBe(0.5);
    expect(sherpaPlaybackRate(0.7)).toBe(1);
  });
});
