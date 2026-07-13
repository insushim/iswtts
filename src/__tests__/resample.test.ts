import { downsampleHalf, shouldHalve } from '../tts/sherpa/resample';

test('길이가 정확히 절반(브릿지 전송·파일·디코드·스트레치 비용의 근거)', () => {
  expect(downsampleHalf(new Array(100).fill(0)).length).toBe(50);
  expect(downsampleHalf(new Array(101).fill(0)).length).toBe(50);
});

test('DC(일정 신호)는 그대로 보존 — 필터 계수 합이 1', () => {
  const out = downsampleHalf(new Array(64).fill(0.5));
  for (const v of out) expect(v).toBeCloseTo(0.5, 6);
});

test('저역 신호(음성 대역)는 진폭이 유지된다', () => {
  const sr = 44100;
  const n = 4410;
  const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / sr)); // 200Hz
  const y = downsampleHalf(x);
  const peak = Math.max(...y.map(Math.abs));
  expect(peak).toBeGreaterThan(0.95); // 거의 무손실
});

test('고역(에일리어싱 유발 대역)은 저역통과로 눌린다', () => {
  const sr = 44100;
  const n = 4410;
  // 20kHz — 22.05kHz 로 내리면 나이퀴스트(11kHz) 위라 반드시 감쇠돼야 한다.
  const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 20000 * i) / sr));
  const y = downsampleHalf(x);
  const peak = Math.max(...y.map(Math.abs));
  expect(peak).toBeLessThan(0.35);
});

test('짧은 입력·빈 입력에서 터지지 않는다', () => {
  expect(downsampleHalf([])).toEqual([]);
  expect(downsampleHalf([0.7])).toEqual([0.7]);
});

test('44.1kHz 급만 절반으로(이미 낮은 출력은 건드리지 않는다)', () => {
  expect(shouldHalve(44100)).toBe(true);
  expect(shouldHalve(48000)).toBe(true);
  expect(shouldHalve(22050)).toBe(false);
  expect(shouldHalve(16000)).toBe(false);
  expect(shouldHalve(Number.NaN)).toBe(false);
});
