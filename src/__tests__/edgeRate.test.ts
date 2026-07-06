import { edgeSsmlMult, edgeSsmlRatePct, edgePlaybackRate } from '../tts/edge/rate';
import { resolveEdgeVoice, EDGE_VOICES } from '../tts/edge/voices';

describe('edge 배속 분담(기하평균 — 양축 극단 회피)', () => {
  test('1× — 둘 다 중립', () => {
    expect(edgeSsmlRatePct(1)).toBe('+0%');
    expect(edgePlaybackRate(1)).toBe(1);
  });

  test('균등 분담 — 두 축이 √rate 씩, 어느 쪽도 극단 금지(핵심 불변식)', () => {
    for (const r of [1.2, 1.5, 2, 2.5, 3, 4]) {
      const ssml = edgeSsmlMult(r);
      const pb = edgePlaybackRate(r);
      expect(ssml * pb).toBeCloseTo(r, 5); // 곱 = 요청 배속
      expect(ssml).toBeLessThanOrEqual(2); // 씹힘 구간(+100%) 미진입 (≤4×)
      expect(pb).toBeLessThanOrEqual(2); // Sonic 상한
    }
    // 2× 대표값: 합성 +41% × 재생 1.414
    expect(edgeSsmlRatePct(2)).toBe('+41%');
    expect(edgePlaybackRate(2)).toBeCloseTo(Math.SQRT2, 3);
    // 3×: 1.732 × 1.732
    expect(edgePlaybackRate(3)).toBeCloseTo(Math.sqrt(3), 3);
  });

  test('4× 초과 — 재생속도 2.0 고정, 초과분은 SSML 흡수', () => {
    expect(edgePlaybackRate(5)).toBe(2);
    expect(edgeSsmlMult(5)).toBeCloseTo(2.5, 5);
    expect(edgeSsmlRatePct(6)).toBe('+200%');
  });

  test('상한 — 6× 초과 요청은 실효 6× 로 클램프', () => {
    expect(edgeSsmlRatePct(10)).toBe('+200%');
    expect(edgePlaybackRate(10)).toBe(2);
  });

  test('저속(<1×) — 신경망 합성(SSML)이 전담, 재생속도 1×', () => {
    expect(edgeSsmlRatePct(0.5)).toBe('-50%');
    expect(edgePlaybackRate(0.5)).toBe(1);
  });

  test('비정상 입력 — 기본 1×', () => {
    expect(edgeSsmlRatePct(undefined)).toBe('+0%');
    expect(edgePlaybackRate(NaN)).toBe(1);
  });
});

describe('가상 음성(pitch 변조) 해석', () => {
  test('원본 음성 — 그대로, pitch 중립', () => {
    expect(resolveEdgeVoice('ko-KR-SunHiNeural')).toEqual({ voice: 'ko-KR-SunHiNeural', pitch: '+0Hz' });
  });

  test('가상 음성 — 기본음성 + 변조 pitch', () => {
    const girl = resolveEdgeVoice('ko-KR-SunHiNeural#girl');
    expect(girl.voice).toBe('ko-KR-SunHiNeural');
    expect(girl.pitch).not.toBe('+0Hz');
    const boy = resolveEdgeVoice('ko-KR-HyunsuMultilingualNeural#boy');
    expect(boy.voice).toBe('ko-KR-HyunsuMultilingualNeural');
    expect(boy.pitch).not.toBe('+0Hz');
  });

  test('알 수 없는 variant — pitch 중립으로 안전 폴백', () => {
    expect(resolveEdgeVoice('ko-KR-SunHiNeural#zzz').pitch).toBe('+0Hz');
  });

  test('목록의 모든 가상 음성 id 는 실제 기본음성으로 해석된다', () => {
    const baseIds = new Set(EDGE_VOICES.filter((v) => !v.id.includes('#')).map((v) => v.id));
    for (const v of EDGE_VOICES.filter((v) => v.id.includes('#'))) {
      expect(baseIds.has(resolveEdgeVoice(v.id).voice)).toBe(true);
    }
  });
});
