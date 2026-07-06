import { sherpaModelSpeed, sherpaPlaybackRate, SHERPA_PLAYBACK_MAX } from '../tts/sherpa/rate';

describe('sherpa 배속(모델은 저속만, 1× 초과는 재생속도)', () => {
  test('1× — 둘 다 중립', () => {
    expect(sherpaModelSpeed(1)).toBe(1);
    expect(sherpaPlaybackRate(1)).toBe(1);
  });

  test('모델 speed 는 1.0 초과 금지 — 음소 붕괴 재발 방지 핵심 불변식(CER 실측: 2.0=72%)', () => {
    for (const r of [1.2, 1.5, 2, 2.5, 3, 10]) {
      expect(sherpaModelSpeed(r)).toBe(1);
    }
  });

  test('1× 초과는 재생속도 전담, 3× 클램프', () => {
    expect(sherpaPlaybackRate(1.5)).toBe(1.5);
    expect(sherpaPlaybackRate(2)).toBe(2);
    expect(sherpaPlaybackRate(3)).toBe(3);
    expect(sherpaPlaybackRate(5)).toBe(SHERPA_PLAYBACK_MAX);
  });

  test('저속(<1×)은 모델이 자연스럽게 합성, 재생속도 1×', () => {
    expect(sherpaModelSpeed(0.7)).toBe(0.7);
    expect(sherpaModelSpeed(0.3)).toBe(0.5); // 하한
    expect(sherpaPlaybackRate(0.7)).toBe(1);
  });
});
