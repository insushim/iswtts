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
import { buildSilenceWav, buildPcmWav } from './silenceWav';
import { makeGapBreath } from '../tts/sherpa/breathWav';
import { disposePlayer } from '../tts/disposePlayer';

const STEP_MS = 50;
export const GAP_MIN_MS = 60; // 이보다 짧은 쉼은 플레이어 기동 지연이 곧 쉼 — 그냥 즉시 진행
// 방어 클램프 = pacing 이론 최댓값(MAX_EXTRA 700 + 지터 50) ÷ 최저 배속(settings 0.5×).
// ⚠️ 최저 배속을 더 낮추면 이 값도 함께 — 아니면 극저속에서 쉼이 조용히 잘린다.
const GAP_MAX_MS = 1500;

// ── 문단 들숨(v1.26.0) ─────────────────────────────────
// 사람 낭독자는 새 문단(장면 전환) 앞에서 크게 숨을 들이쉰다 — 문단 쉼(pacing.ts
// PARAGRAPH_MS)의 무음 일부를 합성 들숨(breathWav.ts makeGapBreath — 근거·파라미터·길이
// 적응 로직 그 파일)으로 채운다. 재생 단계라 합성 캐시 무손상. 옵션(settings.breathSound)
// 일 때만, 그리고 쉼에 들숨이 통째로 들어갈 때만(짧으면 makeGapBreath 가 null — 절단된
// 들숨은 릴리즈가 사라져 딱 소리, 교차검증 Gemini 지적 2026-07-20).
const BREATH_GAP_SR = 22050; // 들숨 대역 상한(2.6kHz)에 충분 + 파일 소형

// 들숨 파일명 세대 — 파형 알고리즘·파라미터가 바뀌면 +1 해서 구형 캐시를 무효화할 것.
// 크기 검사만으로는 "같은 길이·다른 파형"을 못 잡는다(교차검증 codex 지적 2026-07-20 —
// 실제로 개발 중 고정길이→적응형 전환에서 이 케이스가 났다). 무음 파일은 내용이 0뿐이라
// 세대 불필요.
const BREATH_FILE_GEN = 2;

function gapFileUri(ms: number, breath: boolean): string {
  const gb = breath ? makeGapBreath(ms, BREATH_GAP_SR) : null;
  const f = new File(Paths.cache, gb ? `gap-b${BREATH_FILE_GEN}-${ms}.wav` : `gap-${ms}.wav`);
  let wav: Uint8Array;
  if (gb) {
    const total = Math.round((BREATH_GAP_SR * ms) / 1000);
    const lead = Math.round((BREATH_GAP_SR * gb.leadMs) / 1000);
    const samples = new Array<number>(total).fill(0);
    for (let i = 0; i < gb.samples.length && lead + i < total; i++) samples[lead + i] = gb.samples[i];
    wav = buildPcmWav(samples, BREATH_GAP_SR);
  } else {
    wav = buildSilenceWav(ms / 1000);
  }
  // 크기 불일치 = 잘린 파일(과거 크래시) — 재생성(mediaSession 앵커와 동일 방침).
  if (f.exists && f.size !== wav.length) f.delete();
  if (!f.exists) {
    f.create();
    f.write(wav);
  }
  return f.uri;
}

/**
 * ms 만큼 무음(옵션: 문단 들숨 포함)을 재생한 뒤 onDone 을 부른다. 반환값 = 취소 함수
 * (취소 시 onDone 미호출). opts.breath 는 쉼에 들숨이 통째로 들어갈 때만 실효
 * (breathWav.ts GAP_BREATH_MIN_TOTAL_MS — 짧으면 무음 쉼으로 폴백).
 * 실패(파일/플레이어 오류) 시엔 즉시 onDone — 쉼이 빠질지언정 낭독이 멈추진 않는다.
 */
export function playGap(ms: number, onDone: () => void, opts?: { breath?: boolean }): () => void {
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
    player = createAudioPlayer(gapFileUri(rounded, !!opts?.breath));
    sub = player.addListener('playbackStatusUpdate', (st) => {
      // error: 파일 손상 등으로 재생이 실패하면 didJustFinish 가 영영 안 와서 낭독이 그
      // 자리에 멈춘다(교차검증 codex 지적 2026-07-20) — 쉼을 포기하고 즉시 진행(catch
      // 경로와 같은 방침: 쉼이 빠질지언정 낭독이 멈추진 않는다).
      if (st.didJustFinish || st.error) finish(true);
    });
    player.play();
  } catch {
    // 무음 재생 실패 — 쉼 없이 즉시 진행(멈춤보다 낫다). 마이크로태스크로 재진입 안전화.
    Promise.resolve().then(() => finish(true));
  }
  return () => finish(false);
}
