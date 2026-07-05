// TTS 엔진 레지스트리. settings.engineId 로 엔진을 고른다.
// 새 엔진(sherpa-onnx 오프라인 신경망 등)은 여기 한 줄과 파일 하나만 추가하면 된다.
import type { TtsEngine } from './TtsEngine';
import { systemEngine } from './ExpoSpeechEngine';
import { edgeEngine } from './edge/EdgeTtsEngine';

export type { EngineId } from '../types';

export function getEngine(id?: string): TtsEngine {
  return id === 'edge' ? edgeEngine : systemEngine;
}

export { systemEngine, edgeEngine };
export type { TtsEngine };
