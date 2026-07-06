import { edgeSsmlMult, edgeSsmlRatePct, edgePlaybackRate } from '../tts/edge/rate';
import { resolveEdgeVoice, EDGE_VOICES } from '../tts/edge/voices';

describe('edge 배속(≤2× 순수 SSML, 초과분 스트레치 — 상한 없음)', () => {
  test('1× — 중립', () => {
    expect(edgeSsmlRatePct(1)).toBe('+0%');
    expect(edgePlaybackRate(1)).toBe(1);
  });

  test('≤2×는 스트레치 0(원래 소리 그대로 — 사용자 청감 확정), 초과분만 스트레치 흡수', () => {
    for (const r of [0.5, 1, 1.5, 2]) {
      expect(edgePlaybackRate(r)).toBe(1);
    }
    // 상한 없음: 설정 배속 = 실효 배속(합성 2× × 스트레치)
    expect(edgePlaybackRate(3)).toBeCloseTo(1.5, 5);
    expect(edgePlaybackRate(4)).toBeCloseTo(2, 5);
    expect(edgeSsmlMult(4) * edgePlaybackRate(4)).toBeCloseTo(4, 5);
  });

  test('배속은 전부 SSML — 요청 배속 그대로, 서버 포화점(2×)에서 클램프', () => {
    expect(edgeSsmlRatePct(1.5)).toBe('+50%');
    expect(edgeSsmlRatePct(2)).toBe('+100%');
    for (const r of [2.5, 3, 10]) {
      expect(edgeSsmlRatePct(r)).toBe('+100%'); // +100% 초과 요청은 서버가 무시(동일 길이 실측)
    }
    expect(edgeSsmlRatePct(0.5)).toBe('-50%');
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
