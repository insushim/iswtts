import { create } from 'zustand';
import type { TtsEngine } from '../tts/TtsEngine';
import { getEngine, systemEngine } from '../tts';
import { EDGE_MAX_RATE } from '../tts/edge/rate';
import { SHERPA_PLAYBACK_MAX } from '../tts/sherpa/rate';
import { useSettings } from './settings';
import { useLibrary } from './library';
import {
  startMediaSession,
  pauseMediaSession,
  stopMediaSession,
  setRemoteHandlers,
} from '../lib/mediaSession';

// 재생 컨트롤러. 문장 큐를 순회하며 엔진에 발화시키고, onBoundary로 단어 하이라이트를 갱신한다.
// epoch로 stale 콜백(정지/문장전환 후 뒤늦게 온 콜백)을 무효화한다.
let epoch = 0;

// 현재 발화 중인 엔진(정지/문장전환 시 이 엔진을 멈춘다). 엔진 전환 시에도 올바른 엔진을 stop.
let activeEngine: TtsEngine = systemEngine;

// 엔진 서킷브레이커(비-시스템 엔진 공용): 연속 실패가 쌓이면 일정 시간 그 엔진 시도를 건너뛴다.
// (없으면 장애 시 문장마다 타임아웃/합성 실패를 기다린 뒤에야 폴백 — 낭독이 뚝뚝 끊긴다.)
const ENGINE_FAIL_LIMIT = 3;
const ENGINE_BLOCK_MS = 60_000;
const engineFails: Record<string, number> = {};
const engineBlockedUntil: Record<string, number> = {};

function reportEngineFailure(id: string): boolean {
  engineFails[id] = (engineFails[id] || 0) + 1;
  if (engineFails[id] >= ENGINE_FAIL_LIMIT) {
    engineFails[id] = 0;
    engineBlockedUntil[id] = Date.now() + ENGINE_BLOCK_MS;
    return true; // 방금 차단이 발동됨(사용자 알림용)
  }
  return false;
}

// 설정에서 엔진을 다시 고르는 등 사용자가 명시적으로 재시도할 때 호출.
export function resetEngineCircuit(id?: string) {
  if (id) {
    engineFails[id] = 0;
    engineBlockedUntil[id] = 0;
    return;
  }
  for (const k of Object.keys(engineBlockedUntil)) engineBlockedUntil[k] = 0;
  for (const k of Object.keys(engineFails)) engineFails[k] = 0;
}

export type PlayerState = {
  docId: string | null;
  title: string;
  sentences: string[];
  index: number;
  wordStart: number;
  wordLen: number;
  playing: boolean;
  // 사용자에게 보여줄 일시적 알림(재생 실패·폴백 전환 등). PlayerScreen이 배너로 표시 후 지운다.
  notice: string | null;
  setNotice: (msg: string | null) => void;

  load: (args: {
    docId: string;
    title: string;
    sentences: string[];
    startIndex?: number;
  }) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (index: number) => void;
  unload: () => void;
};

// 엔진마다 음성 식별자 체계가 다르다 → "실제 발화할 엔진"(자동 전환 반영) 기준으로 voiceId 전달.
function speakParams(engineId: string) {
  const s = useSettings.getState();
  return {
    rate: s.rate,
    pitch: s.pitch,
    language: s.language,
    voiceId:
      engineId === 'edge' ? s.edgeVoiceId
      : engineId === 'sherpa' ? s.sherpaVoiceId
      : s.voiceId,
  };
}

// Edge 2× 초과 자동 전환 안내는 앱 실행당 1회만(문장마다 배너가 뜨면 소음).
let highSpeedNoticeShown = false;

export const usePlayer = create<PlayerState>((set, get) => {
  const speakCurrent = () => {
    const { sentences, index, docId } = get();
    if (!sentences.length || index < 0 || index >= sentences.length) return;

    // 서킷 열림(연속 실패 백오프) 중엔 해당 엔진을 건너뛰고 시스템으로 — 백오프가 끝나면 자동 재시도.
    const settings = useSettings.getState();
    const wantId = settings.engineId;
    let engineId =
      wantId !== 'system' && Date.now() < (engineBlockedUntil[wantId] || 0) ? 'system' : wantId;
    // 고품질 엔진의 배속 실효 상한(Edge=2× 서버 포화, sherpa=3× 재생속도 — 실측) 초과 설정 시:
    // 기본은 선택 음성 유지(엔진이 상한으로 클램프). 옵션을 켠 경우에만 시스템 TTS로 전환해
    // "진짜" 그 속도를 낸다.
    const engineCap = engineId === 'edge' ? EDGE_MAX_RATE : engineId === 'sherpa' ? SHERPA_PLAYBACK_MAX : Infinity;
    if (settings.rate > engineCap && settings.highSpeedSystemVoice) {
      engineId = 'system';
      if (!highSpeedNoticeShown) {
        highSpeedNoticeShown = true;
        set({ notice: '설정에 따라 고배속은 기본 음성으로 낭독합니다.' });
      }
    }
    const engine = getEngine(engineId);
    // 엔진 전환 시에만 이전 엔진을 완전 정지(그 엔진의 prefetch 캐시까지 비움).
    // 같은 엔진이면 stop()을 부르지 않는다 — engine.speak()가 현재 재생만 끊고 prefetch 캐시는 보존해,
    // 자동진행 시 미리 합성해 둔 다음 문장이 즉시 재생된다(문장 간 딜레이 제거의 핵심).
    if (activeEngine !== engine) activeEngine.stop();
    activeEngine = engine;
    const myEpoch = ++epoch;
    set({ wordStart: 0, wordLen: 0, playing: true });
    // 백그라운드 유지 + 잠금화면 컨트롤(무음 앵커). 문장마다 불려도 무해(멱등).
    startMediaSession(get().title);

    // 진행률 저장
    if (docId) useLibrary.getState().setProgress(docId, index, sentences.length);

    const handlers = {
      onBoundary: (charIndex: number, charLength: number) => {
        if (myEpoch !== epoch) return;
        set({ wordStart: charIndex, wordLen: charLength });
      },
      onDone: () => {
        if (myEpoch !== epoch) return;
        // 비-시스템 엔진이 문장을 무사히 끝냈으면 연속 실패 카운터 리셋.
        if (activeEngine.id !== 'system') engineFails[activeEngine.id] = 0;
        const st = get();
        if (st.index < st.sentences.length - 1) {
          set({ index: st.index + 1 });
          speakCurrent();
        } else {
          set({ playing: false, wordStart: 0, wordLen: 0 });
          pauseMediaSession(); // 책 끝 — 알림은 남겨 ▶ 로 재청취 가능
        }
      },
    };

    const sentence = sentences[index];
    engine.speak(sentence, speakParams(engineId), {
      ...handlers,
      onError: () => {
        if (myEpoch !== epoch) return;
        // 비-시스템 엔진(Edge/sherpa) 실패 시 → 같은 문장을 시스템 TTS로 폴백해 낭독이 끊기지 않게.
        if (engineId !== 'system') {
          // 연속 실패 집계 — 한도 도달 시 잠시 해당 엔진을 차단하고 사용자에게 1회 알림.
          if (reportEngineFailure(engineId)) {
            set({
              notice:
                engineId === 'edge'
                  ? '온라인 음성 연결이 불안정해 잠시 기본 음성으로 낭독합니다.'
                  : '오프라인 고품질 음성 재생에 문제가 있어 잠시 기본 음성으로 낭독합니다.',
            });
          }
          engine.stop(); // 잔여 재생·prefetch 캐시(mp3/wav) 정리(폴백 후 누수 방지)
          activeEngine = systemEngine;
          systemEngine.speak(sentence, speakParams('system'), {
            ...handlers,
            onError: () => {
              if (myEpoch !== epoch) return;
              set({ playing: false, notice: '재생에 실패했습니다 — 기기 TTS 설정을 확인해주세요.' });
              pauseMediaSession();
            },
          });
          return;
        }
        set({ playing: false, notice: '재생에 실패했습니다 — 기기 TTS 설정을 확인해주세요.' });
        pauseMediaSession();
      },
    });

    // 다음 문장을 미리 합성(온라인 엔진의 문장 간 딜레이 제거). 시스템 엔진은 prefetch 미구현 → no-op.
    const nextIdx = index + 1;
    if (nextIdx < sentences.length) {
      engine.prefetch?.(sentences[nextIdx], speakParams(engineId));
    }
  };

  return {
    docId: null,
    title: '',
    sentences: [],
    index: 0,
    wordStart: 0,
    wordLen: 0,
    playing: false,
    notice: null,
    setNotice: (msg) => set({ notice: msg }),

    load: ({ docId, title, sentences, startIndex = 0 }) => {
      activeEngine.stop();
      epoch++;
      pauseMediaSession(); // 새 문서 준비 — 앵커도 정지 상태로 정렬(재생 시 새 제목으로 재개)
      set({
        docId,
        title,
        sentences,
        index: Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1))),
        wordStart: 0,
        wordLen: 0,
        playing: false,
        notice: null, // 이전 문서의 알림이 새 문서에 남지 않게
      });
    },

    play: () => {
      if (!get().sentences.length) return;
      speakCurrent();
    },

    pause: () => {
      epoch++; // 진행 중 콜백 무효화
      activeEngine.stop();
      set({ playing: false });
      pauseMediaSession();
    },

    toggle: () => {
      if (get().playing) get().pause();
      else get().play();
    },

    next: () => {
      const { index, sentences, playing } = get();
      if (index >= sentences.length - 1) return;
      set({ index: index + 1, wordStart: 0, wordLen: 0 });
      if (playing) speakCurrent();
      else {
        const { docId } = get();
        if (docId) useLibrary.getState().setProgress(docId, index + 1, sentences.length);
      }
    },

    prev: () => {
      const { index, sentences, playing } = get();
      if (index <= 0) return;
      set({ index: index - 1, wordStart: 0, wordLen: 0 });
      if (playing) speakCurrent();
      else {
        const { docId } = get();
        if (docId) useLibrary.getState().setProgress(docId, index - 1, sentences.length);
      }
    },

    seek: (i) => {
      const { sentences, playing } = get();
      const clamped = Math.max(0, Math.min(i, sentences.length - 1));
      set({ index: clamped, wordStart: 0, wordLen: 0 });
      if (playing) speakCurrent();
      else {
        // 정지 중 이동도 진행률 저장(next/prev와 동일 동작 — 일관성).
        const { docId } = get();
        if (docId) useLibrary.getState().setProgress(docId, clamped, sentences.length);
      }
    },

    unload: () => {
      epoch++;
      activeEngine.stop();
      stopMediaSession(); // 잠금화면 알림까지 제거
      set({
        docId: null,
        title: '',
        sentences: [],
        index: 0,
        wordStart: 0,
        wordLen: 0,
        playing: false,
      });
    },
  };
});

// 잠금화면/알림의 ▶·⏸ 는 네이티브가 앵커 플레이어를 직접 제어한다 — 그 상태 변화를
// 스토어의 play/pause 로 되비쳐 낭독(엔진)과 UI 를 함께 동기화한다.
setRemoteHandlers({
  onRemotePlay: () => {
    const st = usePlayer.getState();
    if (st.playing) return;
    if (st.sentences.length) st.play();
    else pauseMediaSession(); // 읽을 문서가 없으면 앵커만 되돌림
  },
  onRemotePause: () => {
    const st = usePlayer.getState();
    if (st.playing) st.pause();
  },
});
