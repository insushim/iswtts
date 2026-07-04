import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SettingsState = {
  rate: number;         // 재생 속도 (0.5 .. 2.0)
  pitch: number;
  language: string;     // BCP-47
  voiceId?: string;     // 선택 음성(엔진 식별자)
  fontScale: number;    // 자막 글자 배율 (0.8 .. 1.8)
  set: (patch: Partial<SettingsState>) => void;
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      rate: 1.0,
      pitch: 1.0,
      language: 'ko-KR',
      voiceId: undefined,
      fontScale: 1.0,
      set: (patch) => set(patch),
    }),
    {
      name: 'iwtts-settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        rate: s.rate,
        pitch: s.pitch,
        language: s.language,
        voiceId: s.voiceId,
        fontScale: s.fontScale,
      }),
    },
  ),
);
