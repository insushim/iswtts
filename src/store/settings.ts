import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { EngineId } from '../types';

export type { EngineId };

export type SettingsState = {
  engineId: EngineId;   // 'system'=온디바이스 시스템 TTS(기본·오프라인), 'edge'=Edge 온라인 신경망
  rate: number;         // 재생 속도 (0.5 .. 10.0). Android setSpeechRate는 피치 보존.
  pitch: number;        // 음높이 (0.5 .. 2.0). 1.0 유지가 배속 시 가장 또렷.
  language: string;     // BCP-47
  voiceId?: string;       // 시스템 엔진 선택 음성(엔진 식별자)
  edgeVoiceId?: string;   // Edge 엔진 선택 음성(예: ko-KR-SunHiNeural). 엔진마다 식별자 체계가 달라 분리.
  sherpaVoiceId?: string; // sherpa(오프라인 신경망) 화자 sid('0'~'9')
  // 대사(따옴표 발화)를 다른 목소리로 낭독(멀티보이스). 대사 음성 미지정 시 자동 대비 음성.
  dialogueVoice: boolean;
  dialogueVoiceId?: string;       // 시스템 엔진 대사 음성(미지정 = 같은 음성 + 피치 대비)
  edgeDialogueVoiceId?: string;   // Edge 대사 음성(미지정 = 자동 대비: 여↔남)
  sherpaDialogueVoiceId?: string; // sherpa 대사 화자 sid(미지정 = 기본 화자 + 1)
  fontScale: number;    // 자막 글자 배율 (0.8 .. 1.8)
  set: (patch: Partial<SettingsState>) => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      engineId: 'system',
      rate: 1.0,
      pitch: 1.0,
      language: 'ko-KR',
      voiceId: undefined,
      edgeVoiceId: undefined,
      sherpaVoiceId: undefined,
      dialogueVoice: false,
      dialogueVoiceId: undefined,
      edgeDialogueVoiceId: undefined,
      sherpaDialogueVoiceId: undefined,
      fontScale: 1.0,
      // 스토어 레벨 방어 클램프 — 어떤 호출부에서도 범위를 벗어난 값이 엔진까지 흐르지 않게.
      set: (patch) => {
        const next: Partial<SettingsState> = { ...patch };
        if (next.rate != null) next.rate = clamp(next.rate, 0.5, 10);
        if (next.pitch != null) next.pitch = clamp(next.pitch, 0.5, 2);
        if (next.fontScale != null) next.fontScale = clamp(next.fontScale, 0.8, 1.8);
        set(next);
      },
    }),
    {
      name: 'iwtts-settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        engineId: s.engineId,
        rate: s.rate,
        pitch: s.pitch,
        language: s.language,
        voiceId: s.voiceId,
        edgeVoiceId: s.edgeVoiceId,
        sherpaVoiceId: s.sherpaVoiceId,
        dialogueVoice: s.dialogueVoice,
        dialogueVoiceId: s.dialogueVoiceId,
        edgeDialogueVoiceId: s.edgeDialogueVoiceId,
        sherpaDialogueVoiceId: s.sherpaDialogueVoiceId,
        fontScale: s.fontScale,
      }),
    },
  ),
);
