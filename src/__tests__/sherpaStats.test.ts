import {
  recordSynth,
  recordStarvation,
  recordPlaybackProgress,
  sherpaStats,
  resetSherpaStats,
} from '../tts/sherpa/stats';

beforeEach(() => resetSherpaStats());

test('첫 표본은 그대로, 이후는 EWMA(α=0.3)로 최근값에 반응', () => {
  recordSynth(1000, 5000); // 0.2 → 첫 표본
  expect(sherpaStats().avgRtf).toBeCloseTo(0.2, 5);
  recordSynth(2000, 5000); // 0.4 → 0.2 + 0.3*(0.4-0.2) = 0.26
  const s = sherpaStats();
  expect(s.synths).toBe(2);
  expect(s.avgRtf).toBeCloseTo(0.26, 5);
});

// 발열 스로틀링 시나리오: 초반 20건이 빠르고(0.2) 후반이 느려지면(0.9), 누적평균은
// 0.23 에 머물러 경고가 안 걸린다. EWMA 는 최근 성능을 따라가 경고 조건에 도달해야 한다.
test('장시간 낭독 후반 성능 저하를 희석하지 않는다', () => {
  for (let i = 0; i < 20; i++) recordSynth(1000, 5000); // 0.2 × 20
  for (let i = 0; i < 6; i++) recordSynth(4500, 5000); // 0.9 × 6 (스로틀링)
  expect(sherpaStats().avgRtf).toBeGreaterThan(0.6);
});

test('0 길이·음수는 무시(0 나눗셈·오염 방지)', () => {
  recordSynth(100, 0);
  recordSynth(-1, 100);
  expect(sherpaStats().synths).toBe(0);
});

test('짧은 대기(<150ms)는 리듬에 안 잡히므로 집계하지 않는다', () => {
  recordStarvation(10, 1000);
  recordStarvation(149, 1000);
  expect(sherpaStats().starved).toBe(0);
});

test('유의미한 대기만 누적(횟수·총합·마지막 시각)', () => {
  recordStarvation(200, 5000);
  recordStarvation(800, 9000);
  const s = sherpaStats();
  expect(s.starved).toBe(2);
  expect(s.starvedMs).toBe(1000);
  expect(s.lastStarvedAt).toBe(9000);
});

// ── 재생 진행 감시(언더런/스톨) ───────────────────────────────
// 두 수치가 가설을 가른다: starvedMs=합성이 못 따라감 / stallMs=재생 자체가 끊김.

test('1.5배속에서 정상 재생(벽시계 100ms 동안 오디오 150ms 전진)은 끊김 0', () => {
  recordPlaybackProgress(100, 150, 1.5);
  expect(sherpaStats().stallMs).toBe(0);
});

test('오디오가 전혀 안 나간 구간은 그 벽시계 시간만큼 끊김으로 적립', () => {
  recordPlaybackProgress(100, 0, 1.5);
  expect(sherpaStats().stallMs).toBeCloseTo(100, 5);
});

test('기대의 절반만 전진하면 못 간 몫만 적립', () => {
  recordPlaybackProgress(100, 75, 1.5); // 기대 150 → progress 0.5
  expect(sherpaStats().stallMs).toBeCloseTo(50, 5);
});

test('경미한 지터(이벤트 타이밍 오차)는 끊김으로 세지 않는다', () => {
  recordPlaybackProgress(100, 120, 1.5); // progress 0.8 ≥ 0.7
  expect(sherpaStats().stallMs).toBe(0);
});

test('백그라운드 복귀 등 벽시계만 크게 흐른 구간은 버린다(재생 결함 아님)', () => {
  recordPlaybackProgress(30_000, 0, 1.5);
  expect(sherpaStats().stallMs).toBe(0);
});

test('sherpaStats 는 복사본을 준다(외부 변형이 내부 상태를 오염시키지 않게)', () => {
  recordSynth(500, 1000);
  const a = sherpaStats();
  a.synths = 999;
  expect(sherpaStats().synths).toBe(1);
});
