import type { EngineVoice } from '../TtsEngine';

// Edge 신경망 음성 큐레이션. 전체 목록은 수백 개라, 낭독에 적합한 자연 음성만 언어별로 선별.
// id 는 Edge SSML voice name(그대로 SSML 에 들어감).
export const EDGE_VOICES: EngineVoice[] = [
  // 한국어
  { id: 'ko-KR-SunHiNeural', name: '선희 (여, 표준)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-InJoonNeural', name: '인준 (남, 표준)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-HyunsuMultilingualNeural', name: '현수 (남, 멀티링구얼)', language: 'ko-KR', quality: 'Neural' },
  // 영어
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (여, multilingual)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew (남, multilingual)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-AvaNeural', name: 'Ava (여)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-GuyNeural', name: 'Guy (남)', language: 'en-US', quality: 'Neural' },
  // 일본어
  { id: 'ja-JP-NanamiNeural', name: 'Nanami (여)', language: 'ja-JP', quality: 'Neural' },
  { id: 'ja-JP-KeitaNeural', name: 'Keita (남)', language: 'ja-JP', quality: 'Neural' },
  // 중국어(보통화)
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (여)', language: 'zh-CN', quality: 'Neural' },
  { id: 'zh-CN-YunxiNeural', name: 'Yunxi (남)', language: 'zh-CN', quality: 'Neural' },
];

// 언어 코드(예: 'ko-KR', 'ko')로 기본 음성 선택.
export function defaultEdgeVoice(language?: string): string {
  const lang = (language || 'ko-KR').toLowerCase();
  const prefix = lang.split('-')[0];
  const match = EDGE_VOICES.find((v) => v.language.toLowerCase().startsWith(prefix));
  return match ? match.id : 'ko-KR-SunHiNeural';
}
