import { subtitlesVisible, onVisibilityChange, setPipVisible } from '../lib/visibility';

// 자막 가시성 = 앱 포그라운드(AppState) 또는 PiP. 엔진의 폴링/리렌더 on-off 를 이 신호가
// 결정하므로, "변화에만 통지"와 "해제 후 무통지"가 깨지면 배터리 절감이 무효화되거나
// 죽은 플레이어의 폴링이 되살아난다.
//
// 테스트 환경의 AppState 는 'active' 가 아니므로 초기 가시성은 false — PiP 만으로 켜고 끈다.

afterEach(() => setPipVisible(false));

test('PiP 진입/이탈이 가시성을 켜고 끈다', () => {
  expect(subtitlesVisible()).toBe(false);
  setPipVisible(true);
  expect(subtitlesVisible()).toBe(true);
  setPipVisible(false);
  expect(subtitlesVisible()).toBe(false);
});

test('구독자는 값이 실제로 바뀔 때만 호출된다(같은 값 반복 설정은 무시)', () => {
  const seen: boolean[] = [];
  const off = onVisibilityChange((v) => seen.push(v));
  setPipVisible(true);
  setPipVisible(true); // 같은 값 — 재통지 없어야 함
  setPipVisible(false);
  setPipVisible(false);
  off();
  expect(seen).toEqual([true, false]);
});

test('구독 해제 후에는 호출되지 않는다(발화마다 구독이 쌓여도 누수 없게)', () => {
  const seen: boolean[] = [];
  const off = onVisibilityChange((v) => seen.push(v));
  off();
  setPipVisible(true);
  expect(seen).toEqual([]);
});

test('구독자 하나가 throw 해도 나머지는 계속 통지받는다', () => {
  const seen: boolean[] = [];
  const offA = onVisibilityChange(() => {
    throw new Error('boom');
  });
  const offB = onVisibilityChange((v) => seen.push(v));
  expect(() => setPipVisible(true)).not.toThrow();
  offA();
  offB();
  expect(seen).toEqual([true]);
});
