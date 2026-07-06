import { edgeSsmlMult, edgeSsmlRatePct, edgePlaybackRate } from '../tts/edge/rate';
import { resolveEdgeVoice, EDGE_VOICES } from '../tts/edge/voices';

describe('edge 배속 분담(재생속도 우선)', () => {
  test('1× — 둘 다 중립', () => {
    expect(edgeSsmlRatePct(1)).toBe('+0%');
    expect(edgePlaybackRate(1)).toBe(1);
  });

  test('≤2× — SSML 은 자연속도 유지, 재생속도가 전담(씹힘 방지 핵심)', () => {
    expect(edgeSsmlRatePct(1.5)).toBe('+0%');
    expect(edgePlaybackRate(1.5)).toBe(1.5);
    expect(edgeSsmlRatePct(2)).toBe('+0%');
    expect(edgePlaybackRate(2)).toBe(2);
  });

  test('2× 초과 — 초과분만 SSML 분담, 곱이 요청 배속과 일치', () => {
    expect(edgeSsmlMult(3) * edgePlaybackRate(3)).toBeCloseTo(3);
    expect(edgeSsmlRatePct(3)).toBe('+50%');
    expect(edgePlaybackRate(3)).toBe(2);
    expect(edgeSsmlMult(6) * edgePlaybackRate(6)).toBeCloseTo(6);
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
