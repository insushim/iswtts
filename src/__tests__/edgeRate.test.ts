import { edgeSsmlMult, edgeSsmlRatePct, edgePlaybackRate } from '../tts/edge/rate';
import { resolveEdgeVoice, EDGE_VOICES } from '../tts/edge/voices';

describe('edge 배속 분담(기하평균 + 총 2× 클램프)', () => {
  test('1× — 둘 다 중립', () => {
    expect(edgeSsmlRatePct(1)).toBe('+0%');
    expect(edgePlaybackRate(1)).toBe(1);
  });

  test('≤2× — 균등 분담: 두 축이 √rate 씩, 어느 쪽도 극단 금지(핵심 불변식)', () => {
    for (const r of [1.2, 1.5, 1.8, 2]) {
      const ssml = edgeSsmlMult(r);
      const pb = edgePlaybackRate(r);
      expect(ssml * pb).toBeCloseTo(r, 5); // 곱 = 요청 배속
      expect(ssml).toBeLessThanOrEqual(Math.SQRT2 + 1e-9); // SSML 포화(+100%)에 여유
      expect(pb).toBeLessThanOrEqual(Math.SQRT2 + 1e-9); // Sonic 겹침 파괴 구간 회피
    }
    // 2× 대표값: 합성 +41% × 재생 1.414 (Whisper CER 실측 최저 조합)
    expect(edgeSsmlRatePct(2)).toBe('+41%');
    expect(edgePlaybackRate(2)).toBeCloseTo(Math.SQRT2, 3);
  });

  test('2× 초과 — 실효 2× 클램프(초과 배속은 엔진 전환이 담당, rate.ts 는 품질 보장 상한 고수)', () => {
    for (const r of [2.5, 3, 6, 10]) {
      expect(edgeSsmlMult(r)).toBeCloseTo(edgeSsmlMult(2), 5);
      expect(edgePlaybackRate(r)).toBeCloseTo(edgePlaybackRate(2), 5);
    }
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
