// TTS 엔진 추상화(전략 패턴). v1은 온디바이스 시스템 TTS(ExpoSpeechEngine)만.
// 나중에 sherpa-onnx(오프라인 신경망)·자가호스팅 Fish Speech(클라우드/클론)를
// 같은 인터페이스로 끼워 넣어 UI/플레이어 변경 없이 스왑한다.

export type SpeakHandlers = {
  onBoundary?: (charIndex: number, charLength: number) => void;
  onDone?: () => void;
  onError?: (e: Error) => void;
};

export type SpeakParams = {
  rate?: number;     // 0.5 .. 5.0 (Android 시스템 TTS는 피치 보존 배속). iOS는 ~2.0에서 상한.
  pitch?: number;
  voiceId?: string;  // 엔진별 음성 식별자
  language?: string; // BCP-47 (예: ko-KR)
};

export type EngineVoice = {
  id: string;
  name: string;
  language: string;
  quality?: string;
};

export interface TtsEngine {
  readonly id: string;
  readonly offline: boolean;
  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void;
  stop(): void;
  getVoices(): Promise<EngineVoice[]>;
}
