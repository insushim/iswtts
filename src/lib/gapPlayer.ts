// 문장 사이 "쉼"을 무음 WAV 재생으로 구현 — 낭독 페이스(pacing.ts)의 실행 장치.
//
// 왜 setTimeout 이 아닌가(v1.23.0 회귀 실측 2026-07-19): RN 의 JS 타이머는 화면 꺼짐·
// 백그라운드(다른 앱 시청 중)에서 얼어붙는다(이 코드베이스의 기존 실측 — PiP 자막,
// mediaSession 주석 참조). v1.23.0 이 쉼을 setTimeout 으로 걸어 화면을 끄면 다음 문장
// 전환에서 영영 멈췄다("화면 끄면 목소리가 안 나온다" 보고). 무음 파일 재생의
// didJustFinish 는 네이티브 오디오 이벤트라 화면·포그라운드 상태와 무관하게 도착한다.
//
// 파일: 50ms 단위로 반올림한 길이별 무음 WAV 를 캐시 디렉토리에 1회 생성 후 재사용
// (8kHz mono 16-bit — 750ms ≈ 12KB, 종류 ≤ 15개).

import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { buildSilenceWav } from './silenceWav';
import { disposePlayer } from '../tts/disposePlayer';

const STEP_MS = 50;
export const GAP_MIN_MS = 60; // 이보다 짧은 쉼은 플레이어 기동 지연이 곧 쉼 — 그냥 즉시 진행
// 방어 클램프 = pacing 이론 최댓값(MAX_EXTRA 700 + 지터 50) ÷ 최저 배속(settings 0.5×).
// ⚠️ 최저 배속을 더 낮추면 이 값도 함께 — 아니면 극저속에서 쉼이 조용히 잘린다.
const GAP_MAX_MS = 1500;

function gapFileUri(ms: number): string {
  const f = new File(Paths.cache, `gap-${ms}.wav`);
  const wav = buildSilenceWav(ms / 1000);
  // 크기 불일치 = 잘린 파일(과거 크래시) — 재생성(mediaSession 앵커와 동일 방침).
  if (f.exists && f.size !== wav.length) f.delete();
  if (!f.exists) {
    f.create();
    f.write(wav);
  }
  return f.uri;
}

/**
 * ms 만큼 무음을 재생한 뒤 onDone 을 부른다. 반환값 = 취소 함수(취소 시 onDone 미호출).
 * 실패(파일/플레이어 오류) 시엔 즉시 onDone — 쉼이 빠질지언정 낭독이 멈추진 않는다.
 */
export function playGap(ms: number, onDone: () => void): () => void {
  let finished = false;
  let player: AudioPlayer | null = null;
  let sub: { remove: () => void } | null = null;
  const cleanup = () => {
    if (sub) { try { sub.remove(); } catch { /* noop */ } sub = null; }
    if (player) { const p = player; player = null; disposePlayer(p); }
  };
  const finish = (fire: boolean) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (fire) onDone();
  };
  try {
    const rounded = Math.min(GAP_MAX_MS, Math.max(STEP_MS, Math.round(ms / STEP_MS) * STEP_MS));
    player = createAudioPlayer(gapFileUri(rounded));
    sub = player.addListener('playbackStatusUpdate', (st) => {
      if (st.didJustFinish) finish(true);
    });
    player.play();
  } catch {
    // 무음 재생 실패 — 쉼 없이 즉시 진행(멈춤보다 낫다). 마이크로태스크로 재진입 안전화.
    Promise.resolve().then(() => finish(true));
  }
  return () => finish(false);
}
