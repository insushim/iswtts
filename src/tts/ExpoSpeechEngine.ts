import * as Speech from 'expo-speech';
import type {
  TtsEngine,
  SpeakParams,
  SpeakHandlers,
  EngineVoice,
} from './TtsEngine';

// 안드로이드 시스템 TTS(구글/삼성 등) 래퍼. 완전 무료·오프라인(설치된 음성 데이터 기준).
// onBoundary로 단어별 문자 범위를 받아 자막 하이라이트에 사용한다.
export class ExpoSpeechEngine implements TtsEngine {
  readonly id = 'system';
  readonly offline = true;

  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void {
    // 이전 발화를 즉시 끊고 새 문장 발화(문장 전환/수동 이동 시 중첩·큐잉 방지).
    // 이로써 상위 플레이어는 발화 전 별도 stop 호출이 필요 없다(엔진이 자기 interrupt를 책임).
    Speech.stop();
    Speech.speak(text, {
      language: params.language,
      voice: params.voiceId,
      rate: params.rate ?? 1.0,
      pitch: params.pitch ?? 1.0,
      onBoundary: (ev: any) => {
        if (ev && typeof ev.charIndex === 'number') {
          handlers.onBoundary?.(ev.charIndex, ev.charLength ?? 0);
        }
      },
      onDone: () => handlers.onDone?.(),
      onStopped: () => {
        /* stop()으로 중단된 경우 — onDone을 부르지 않는다(다음 문장 자동진행 방지) */
      },
      onError: (e: any) =>
        handlers.onError?.(e instanceof Error ? e : new Error(String(e))),
    });
  }

  stop(): void {
    Speech.stop();
  }

  async getVoices(): Promise<EngineVoice[]> {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      return voices.map((v) => ({
        id: v.identifier,
        name: v.name,
        language: v.language,
        quality: String(v.quality ?? ''),
      }));
    } catch {
      return [];
    }
  }
}

export const systemEngine = new ExpoSpeechEngine();
