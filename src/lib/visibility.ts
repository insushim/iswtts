import { AppState } from 'react-native';

// "자막을 볼 사람이 있는가" 전역 신호 — 배터리 최적화의 축.
//
// 왜(2026-07-14 사용자 보고 "배터리를 엄청 먹네"): 낭독은 화면을 꺼도 이어지는데(무음 앵커 +
// 포그라운드 서비스, mediaSession.ts), 그동안 단어 하이라이트 파이프라인도 같이 돌고 있었다 —
// 엔진의 60ms 폴링 타이머(초당 16.7회 JS 깨움) + 80ms 네이티브 상태 이벤트마다 zustand set →
// React 리렌더. 화면이 꺼져 있으면 그 자막을 볼 사람이 없으므로 전부 순수한 낭비다.
// (오디오 재생·다음 문장 큐잉·선행 합성은 계속돼야 하므로 그건 건드리지 않는다.)
//
// 자막이 실제로 보이는 경우 = 앱이 포그라운드(active). 홈으로 백그라운드가 되거나 화면이 꺼지면
// 보이지 않는다. (작은 창=PiP 는 폐지 — Android 가 PiP 창에서 RN 렌더를 정지시켜 자막이 얼어붙는
// 구조적 한계였다. 배경 청취는 미디어 세션으로 유지. 2026-07-16.)

let appActive = AppState.currentState === 'active';
let last = appActive;

type Listener = (visible: boolean) => void;
const listeners = new Set<Listener>();

function recompute(): void {
  const now = appActive;
  if (now === last) return;
  last = now;
  for (const l of listeners) {
    try {
      l(now);
    } catch {
      /* 구독자 하나의 실패가 나머지를 막지 않게 */
    }
  }
}

/** 지금 단어 하이라이트가 화면에 보이는가(= 그릴 가치가 있는가). */
export function subtitlesVisible(): boolean {
  return last;
}

/** 변화 구독. 반환값을 호출해 해제. */
export function onVisibilityChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 앱 기동 시 1회(App.tsx). AppState 구독을 건다. */
export function initVisibility(): () => void {
  const sub = AppState.addEventListener('change', (s) => {
    appActive = s === 'active';
    recompute();
  });
  return () => sub.remove();
}
