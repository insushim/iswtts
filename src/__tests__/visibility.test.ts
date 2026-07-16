import { AppState } from 'react-native';

// 자막 가시성 = 앱 포그라운드(AppState 'active'). 엔진의 폴링/리렌더 on-off 를 이 신호가
// 결정하므로, "변화에만 통지"와 "해제 후 무통지"가 깨지면 배터리 절감이 무효화되거나
// 죽은 플레이어의 폴링이 되살아난다. (PiP 는 폐지되어 AppState 만이 가시성을 좌우한다.)

// AppState 'change' 핸들러를 가로채 테스트에서 포그라운드/백그라운드를 직접 구동한다.
let changeHandler: (s: string) => void = () => {};
jest
  .spyOn(AppState, 'addEventListener')
  .mockImplementation(((_type: string, cb: (s: string) => void) => {
    changeHandler = cb;
    return { remove: () => {} };
  }) as unknown as typeof AppState.addEventListener);

// 모듈 임포트는 spy 설치 후여야 initVisibility 가 가로챈 핸들러를 등록한다.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { subtitlesVisible, onVisibilityChange, initVisibility } = require('../lib/visibility');

beforeAll(() => initVisibility());
// 매 테스트 시작 전 백그라운드(비가시)로 정렬 — 초기 AppState 값에 의존하지 않게.
beforeEach(() => changeHandler('background'));

test('포그라운드 진입/이탈이 가시성을 켜고 끈다', () => {
  expect(subtitlesVisible()).toBe(false);
  changeHandler('active');
  expect(subtitlesVisible()).toBe(true);
  changeHandler('background');
  expect(subtitlesVisible()).toBe(false);
});

test('구독자는 값이 실제로 바뀔 때만 호출된다(같은 값 반복 설정은 무시)', () => {
  const seen: boolean[] = [];
  const off = onVisibilityChange((v: boolean) => seen.push(v));
  changeHandler('active');
  changeHandler('active'); // 같은 값 — 재통지 없어야 함
  changeHandler('background');
  changeHandler('background');
  off();
  expect(seen).toEqual([true, false]);
});

test('구독 해제 후에는 호출되지 않는다(발화마다 구독이 쌓여도 누수 없게)', () => {
  const seen: boolean[] = [];
  const off = onVisibilityChange((v: boolean) => seen.push(v));
  off();
  changeHandler('active');
  expect(seen).toEqual([]);
});

test('구독자 하나가 throw 해도 나머지는 계속 통지받는다', () => {
  const seen: boolean[] = [];
  const offA = onVisibilityChange(() => {
    throw new Error('boom');
  });
  const offB = onVisibilityChange((v: boolean) => seen.push(v));
  expect(() => changeHandler('active')).not.toThrow();
  offA();
  offB();
  expect(seen).toEqual([true]);
});
