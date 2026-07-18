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
  breath?: boolean;  // 긴 문장 앞 숨소리(설정 breathSound — sherpa 만 구현, 나머지 무시)
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
  // 선택: 미리 합성해 둘 발화 유닛 수(문장/세그먼트). 엔진 특성에 맞춘다 —
  // 오프라인(sherpa)은 CPU 가 재생을 아슬아슬하게 따라가므로 깊게(짧은 문장에서 벌어둔
  // 여유로 무거운 문장을 덮는다), 온라인(Edge)은 문장마다 WebSocket 이라 깊으면 연결 낭비.
  // player.ts 가 이 값으로 prefetch 루프 깊이를 정한다. 미지정 시 보수적 기본(3).
  readonly prefetchUnits?: number;
  speak(text: string, params: SpeakParams, handlers: SpeakHandlers): void;
  stop(): void;
  // 선택: 일시정지 전용 정지 — 재생·진행 중 합성만 내리고 완료된 선행합성(파일)은 보존해,
  // 재개가 캐시 히트로 즉시·부드럽게 시작되게 한다(sherpa). 미구현 엔진은 stop() 폴백.
  suspend?(): void;
  getVoices(): Promise<EngineVoice[]>;
  // 선택: 다음에 읽을 문장을 미리 합성해 둔다(문장 간 딜레이 제거 + 오프라인 파이프라인
  // 버퍼). Edge·sherpa 가 구현, 시스템 엔진은 즉시 발화라 불필요.
  prefetch?(text: string, params: SpeakParams): void;
  // 선택: 재생 중 배속을 문장 재발화 없이 즉시 반영. 현재 문장의 합성 파라미터가 새 배속과
  // 호환될 때만 가능(true 반환). false 면 호출부가 setRateApprox → 재발화 순으로 폴백한다.
  setRate?(rate: number): boolean;
  // 선택: 합성 파라미터 경계를 넘는 배속 변경의 즉각 반영 — 현재 문장 "잔여"만 근사
  // 스트레치로 당장 새 속도처럼 들리게 한다(품질 타협은 그 잔여 몇 초뿐). 예전의 재발화
  // 폴백은 재합성 침묵(실기기 수 초~수십 초) + 문장 재시작이라 "배속이 안 바뀐다"로
  // 체감됐다(사용자 보고 2026-07-18). 다음 문장부터는 정식 분담으로 합성된다.
  setRateApprox?(rate: number): boolean;
  // 선택: 큐에 쌓인 "아직 안 끝난" 선행합성만 취소(완료 파일 보존, 재생은 건드리지 않음).
  // 배속 경계 변경 직후 옛 배속 큐가 새 배속 몫을 막지 않게 호출부가 쓴다.
  cancelPending?(): void;
}
