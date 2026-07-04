import { create } from 'zustand';
import type { TtsEngine } from '../tts/TtsEngine';
import { getEngine, systemEngine } from '../tts';
import { useSettings } from './settings';
import { useLibrary } from './library';

// 재생 컨트롤러. 문장 큐를 순회하며 엔진에 발화시키고, onBoundary로 단어 하이라이트를 갱신한다.
// epoch로 stale 콜백(정지/문장전환 후 뒤늦게 온 콜백)을 무효화한다.
let epoch = 0;

// 현재 발화 중인 엔진(정지/문장전환 시 이 엔진을 멈춘다). 엔진 전환 시에도 올바른 엔진을 stop.
let activeEngine: TtsEngine = systemEngine;

export type PlayerState = {
  docId: string | null;
  title: string;
  sentences: string[];
  index: number;
  wordStart: number;
  wordLen: number;
  playing: boolean;

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

function speakParams() {
  const s = useSettings.getState();
  return {
    rate: s.rate,
    pitch: s.pitch,
    language: s.language,
    // 엔진마다 음성 식별자 체계가 다르다 → 선택 엔진에 맞는 voiceId 전달.
    voiceId: s.engineId === 'edge' ? s.edgeVoiceId : s.voiceId,
  };
}

export const usePlayer = create<PlayerState>((set, get) => {
  const speakCurrent = () => {
    const { sentences, index, docId } = get();
    if (!sentences.length || index < 0 || index >= sentences.length) return;

    const engineId = useSettings.getState().engineId;
    const engine = getEngine(engineId);
    // 엔진 전환 시에만 이전 엔진을 완전 정지(그 엔진의 prefetch 캐시까지 비움).
    // 같은 엔진이면 stop()을 부르지 않는다 — engine.speak()가 현재 재생만 끊고 prefetch 캐시는 보존해,
    // 자동진행 시 미리 합성해 둔 다음 문장이 즉시 재생된다(문장 간 딜레이 제거의 핵심).
    if (activeEngine !== engine) activeEngine.stop();
    activeEngine = engine;
    const myEpoch = ++epoch;
    set({ wordStart: 0, wordLen: 0, playing: true });

    // 진행률 저장
    if (docId) useLibrary.getState().setProgress(docId, index, sentences.length);

    const handlers = {
      onBoundary: (charIndex: number, charLength: number) => {
        if (myEpoch !== epoch) return;
        set({ wordStart: charIndex, wordLen: charLength });
      },
      onDone: () => {
        if (myEpoch !== epoch) return;
        const st = get();
        if (st.index < st.sentences.length - 1) {
          set({ index: st.index + 1 });
          speakCurrent();
        } else {
          set({ playing: false, wordStart: 0, wordLen: 0 });
        }
      },
    };

    const sentence = sentences[index];
    engine.speak(sentence, speakParams(), {
      ...handlers,
      onError: () => {
        if (myEpoch !== epoch) return;
        // Edge(온라인) 실패 시 → 같은 문장을 시스템 TTS로 폴백해 낭독이 끊기지 않게.
        if (engineId === 'edge') {
          engine.stop(); // Edge 잔여 재생·prefetch 캐시(mp3) 정리(폴백 후 누수 방지)
          activeEngine = systemEngine;
          systemEngine.speak(sentence, { ...speakParams(), voiceId: useSettings.getState().voiceId }, {
            ...handlers,
            onError: () => {
              if (myEpoch !== epoch) return;
              set({ playing: false });
            },
          });
          return;
        }
        set({ playing: false });
      },
    });

    // 다음 문장을 미리 합성(온라인 엔진의 문장 간 딜레이 제거). 시스템 엔진은 prefetch 미구현 → no-op.
    const nextIdx = index + 1;
    if (nextIdx < sentences.length) {
      engine.prefetch?.(sentences[nextIdx], speakParams());
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

    load: ({ docId, title, sentences, startIndex = 0 }) => {
      activeEngine.stop();
      epoch++;
      set({
        docId,
        title,
        sentences,
        index: Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1))),
        wordStart: 0,
        wordLen: 0,
        playing: false,
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
    },

    unload: () => {
      epoch++;
      activeEngine.stop();
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
