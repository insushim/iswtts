// TTS 엔진 레지스트리. settings.engineId 로 엔진을 고른다.
// 새 엔진은 여기 한 줄과 파일 하나만 추가하면 된다.
import type { TtsEngine } from './TtsEngine';
import { systemEngine } from './ExpoSpeechEngine';
import { edgeEngine } from './edge/EdgeTtsEngine';
import { sherpaEngine } from './sherpa/SherpaTtsEngine';

export type { EngineId } from '../types';

export function getEngine(id?: string): TtsEngine {
  if (id === 'edge') return edgeEngine;
  if (id === 'sherpa') return sherpaEngine;
  return systemEngine;
}

export { systemEngine, edgeEngine, sherpaEngine };
export type { TtsEngine };
