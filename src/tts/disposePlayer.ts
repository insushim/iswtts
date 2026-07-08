import type { AudioPlayer } from 'expo-audio';

// 플레이어 폐기의 유일 경로 — 반드시 release()까지.
//
// Android expo-audio의 remove()는 모듈 레지스트리에서 빼는 것뿐이고(AudioModule.kt
// `Function("remove") { players.remove(player.id) }`), ExoPlayer·MediaSession·AudioTrack 의
// 실제 해제(releasePlayer())는 JS GC 가 SharedObject 를 수거하는 시점에야 일어난다.
// 이 앱은 문장마다 플레이어를 만들므로(배속 2.5×면 ~2초마다, 프리로드 포함 그 이상)
// GC 사이에 좀비 플레이어가 수십 개 쌓여 AudioTrack 고갈 → 새 문장이 무음으로 멈추거나
// (didJustFinish 미도착 = "재생이 안 됨"), 오디오 언더런으로 속도가 출렁였다(2026-07-08
// 소스 추적). SharedObject.release() 는 네이티브 피어를 즉시 해제한다.
//
// ⚠️ release() 이후 이 객체의 어떤 메서드도 부르면 안 된다 — 호출부는 반드시
// 리스너·폴링을 먼저 정리하고 자기 참조를 비운 뒤 이 함수를 부를 것.
export function disposePlayer(p: AudioPlayer | null | undefined): void {
  if (!p) return;
  try { p.pause(); } catch { /* noop */ }
  try { p.remove(); } catch { /* noop */ }
  try { p.release(); } catch { /* noop */ } // SharedObject 정식 멤버 — 네이티브 피어 즉시 해제
}
