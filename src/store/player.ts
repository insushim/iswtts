import { create } from 'zustand';
import { systemEngine } from '../tts/ExpoSpeechEngine';
import { useSettings } from './settings';
import { useLibrary } from './library';

// 재생 컨트롤러. 문장 큐를 순회하며 엔진에 발화시키고, onBoundary로 단어 하이라이트를 갱신한다.
// epoch로 stale 콜백(정지/문장전환 후 뒤늦게 온 콜백)을 무효화한다.
let epoch = 0;

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
    voiceId: s.voiceId,
  };
}

export const usePlayer = create<PlayerState>((set, get) => {
  const speakCurrent = () => {
    const { sentences, index, docId } = get();
    if (!sentences.length || index < 0 || index >= sentences.length) return;
    systemEngine.stop();
    const myEpoch = ++epoch;
    set({ wordStart: 0, wordLen: 0, playing: true });

    // 진행률 저장
    if (docId) useLibrary.getState().setProgress(docId, index, sentences.length);

    systemEngine.speak(sentences[index], speakParams(), {
      onBoundary: (charIndex, charLength) => {
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
      onError: () => {
        if (myEpoch !== epoch) return;
        set({ playing: false });
      },
    });
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
      systemEngine.stop();
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
      systemEngine.stop();
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
      systemEngine.stop();
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
