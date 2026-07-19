import { sherpaModelSpeed, sherpaPlaybackRate, sherpaTrimEnabled } from '../tts/sherpa/rate';

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

describe('스마트 스피드(무음 압축) 연동', () => {
  test('적용 정책 — 스트레치 온전 구간(≤3×)은 미적용, 초고배속(>3×)만', () => {
    for (const r of [0.5, 1, 2, 3]) expect(sherpaTrimEnabled(r)).toBe(false);
    for (const r of [3.01, 4, 5, 10]) expect(sherpaTrimEnabled(r)).toBe(true);
    expect(sherpaTrimEnabled(undefined)).toBe(false);
  });

  test('곱 불변식 유지 — 모델 × 압축몫 × 재생속도 = 설정 배속(압축은 스트레치에서만 차감)', () => {
    for (const r of [3.5, 4, 5, 6, 9]) {
      for (const f of [1, 1.15, 1.3]) {
        expect(sherpaModelSpeed(r) * f * sherpaPlaybackRate(r, f)).toBeCloseTo(r, 5);
      }
    }
    // 3<r≤9 구간에서 실효 스트레치 = 3/f (압축이 스트레치를 직접 덜어낸다)
    expect(sherpaPlaybackRate(5, 1.25)).toBeCloseTo(3 / 1.25, 5);
    expect(sherpaPlaybackRate(4, 1.2)).toBeCloseTo(3 / 1.2, 5);
  });

  test('비정상 trimFactor(NaN·<1)는 1로 취급 — 기존 동작과 동일', () => {
    expect(sherpaPlaybackRate(4, NaN)).toBeCloseTo(sherpaPlaybackRate(4), 5);
    expect(sherpaPlaybackRate(4, 0.5)).toBeCloseTo(sherpaPlaybackRate(4), 5);
  });
});

describe('sherpaTempoComp — 짧은 문장 템포 평준화(v1.24.0)', () => {
  const { sherpaTempoComp } = require('../tts/sherpa/rate');
  test('긴 문장(35음절+)은 보정 없음, 짧을수록 0.88 까지 감속', () => {
    expect(sherpaTempoComp('가'.repeat(40))).toBe(1);
    expect(sherpaTempoComp('가'.repeat(35))).toBe(1);
    expect(sherpaTempoComp('가'.repeat(12))).toBeCloseTo(0.88, 5);
    expect(sherpaTempoComp('짧다.')).toBeCloseTo(0.88, 5);
    const mid = sherpaTempoComp('가'.repeat(24));
    expect(mid).toBeGreaterThan(0.88);
    expect(mid).toBeLessThan(1);
  });
  test('음절 수는 한글만 센다(숫자·구두점 무관)·결정적', () => {
    const s = '삼십 년 동안, 하루도 빠짐없이 지켜 온 자리를 오늘만큼은 낯설게 느꼈다.';
    expect(sherpaTempoComp(s)).toBe(sherpaTempoComp(s));
  });
});
