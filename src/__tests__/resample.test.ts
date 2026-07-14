import { downsampleHalf, shouldHalve, prepareAudio } from '../tts/sherpa/resample';

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

// ── 회귀 방지: v1.17.0 "뱁새(칩멍크)" 사고 ─────────────────────────
// 다운샘플한 오디오에 원본 샘플레이트를 적어 저장 → 2배속·한 옥타브 위로 재생됐다.
// prepareAudio 는 샘플과 레이트를 한 객체로 묶어 이 불일치를 구조적으로 불가능하게 만든다.

test('44.1kHz 입력: 샘플은 절반, 레이트도 반드시 절반(둘이 함께 움직인다)', () => {
  const x = new Array(1000).fill(0.3);
  const out = prepareAudio(x, 44100);
  expect(out.samples.length).toBe(500);
  expect(out.sampleRate).toBe(22050);
});

test('재생 길이가 원본과 같다 — 이게 깨지면 칩멍크가 된다', () => {
  const x = new Array(44100).fill(0.1); // 정확히 1.0초
  const before = x.length / 44100;
  const out = prepareAudio(x, 44100);
  const after = out.samples.length / out.sampleRate;
  expect(after).toBeCloseTo(before, 6); // 1.0초 → 1.0초 (0.5초가 되면 2배속 재생)
});

test('이미 낮은 레이트는 샘플·레이트 모두 그대로', () => {
  const x = new Array(100).fill(0.2);
  const out = prepareAudio(x, 22050);
  expect(out.samples.length).toBe(100);
  expect(out.sampleRate).toBe(22050);
});
