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
  // 선택: 다음에 읽을 문장을 미리 합성해 둔다(온라인 엔진의 문장 간 딜레이 제거용).
  // 지원 엔진(Edge)만 구현. 시스템 엔진은 즉시 발화라 불필요.
  prefetch?(text: string, params: SpeakParams): void;
  // 선택: 재생 중 배속을 문장 재발화 없이 즉시 반영. 현재 문장의 합성 파라미터가 새 배속과
  // 호환될 때만 가능(true 반환). false 면 호출부가 재발화로 폴백한다.
  setRate?(rate: number): boolean;
}
