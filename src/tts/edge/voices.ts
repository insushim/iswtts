import type { EngineVoice } from '../TtsEngine';

// Edge 신경망 음성 큐레이션. 전체 목록은 수백 개라, 낭독에 적합한 자연 음성만 언어별로 선별.
// id 는 Edge SSML voice name(그대로 SSML 에 들어감).
//
// 가상 음성: Edge 무료 엔드포인트의 한국어 음성은 성인 3종뿐이라, 어린이/청소년은
// 기존 음성에 SSML prosody pitch 변조를 얹은 파생 음성으로 제공한다.
// id 는 `<기본음성>#<variant>` — EDGE_VOICE_VARIANTS 에서 pitch 를 찾고,
// SSML 에는 기본 음성명만 들어간다.
export const EDGE_VOICES: EngineVoice[] = [
  // 한국어 — 성인(원본)
  { id: 'ko-KR-SunHiNeural', name: '선희 (여, 표준)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-InJoonNeural', name: '인준 (남, 표준)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-HyunsuMultilingualNeural', name: '현수 (남, 멀티링구얼)', language: 'ko-KR', quality: 'Neural' },
  // 한국어 — 가상(피치 변조)
  { id: 'ko-KR-SunHiNeural#girl', name: '여자 어린이 (선희 변조)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-HyunsuMultilingualNeural#boy', name: '남자 어린이 (현수 변조)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-SunHiNeural#teen-f', name: '여자 청소년 (선희 변조)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-HyunsuMultilingualNeural#teen-m', name: '남자 청소년 (현수 변조)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-SunHiNeural#grandma', name: '할머니 (선희 변조)', language: 'ko-KR', quality: 'Neural' },
  { id: 'ko-KR-InJoonNeural#grandpa', name: '할아버지 (인준 변조)', language: 'ko-KR', quality: 'Neural' },
  // 영어
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (여, multilingual)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew (남, multilingual)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-AvaNeural', name: 'Ava (여)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-GuyNeural', name: 'Guy (남)', language: 'en-US', quality: 'Neural' },
  { id: 'en-US-AnaNeural', name: 'Ana (여자 어린이)', language: 'en-US', quality: 'Neural' },
  // 일본어
  { id: 'ja-JP-NanamiNeural', name: 'Nanami (여)', language: 'ja-JP', quality: 'Neural' },
  { id: 'ja-JP-KeitaNeural', name: 'Keita (남)', language: 'ja-JP', quality: 'Neural' },
  // 중국어(보통화)
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (여)', language: 'zh-CN', quality: 'Neural' },
  { id: 'zh-CN-YunxiNeural', name: 'Yunxi (남)', language: 'zh-CN', quality: 'Neural' },
];

// variant → pitch 변조량(SSML prosody pitch 상대값).
// 값은 청감 튜닝 대상 — 너무 크면 기계음(칩멍크), 너무 작으면 성인과 구분 안 됨.
const VARIANT_PITCH: Record<string, string> = {
  girl: '+18%',
  boy: '+20%',
  'teen-f': '+8%',
  'teen-m': '+8%',
  // 노년: 피치를 낮춰 중후하게. (느린 말속도까지 얹으면 사용자 배속 설정과 충돌 → pitch만)
  grandma: '-12%',
  grandpa: '-12%',
};

// 음성 id(가상 포함) → SSML 에 넣을 실제 음성명 + pitch.
export function resolveEdgeVoice(id: string): { voice: string; pitch: string } {
  const hash = id.indexOf('#');
  if (hash < 0) return { voice: id, pitch: '+0Hz' };
  const variant = id.slice(hash + 1);
  return { voice: id.slice(0, hash), pitch: VARIANT_PITCH[variant] || '+0Hz' };
}

// 언어 코드(예: 'ko-KR', 'ko')로 기본 음성 선택.
export function defaultEdgeVoice(language?: string): string {
  const lang = (language || 'ko-KR').toLowerCase();
  const prefix = lang.split('-')[0];
  const match = EDGE_VOICES.find((v) => v.language.toLowerCase().startsWith(prefix));
  return match ? match.id : 'ko-KR-SunHiNeural';
}

// 대사 음성 자동 선택: 같은 언어의 원본(비가상) 음성 중 기본 음성과 다른 첫 번째 —
// 목록이 여/남 교차 배치라 자연스럽게 성별 대비가 난다(선희→인준, 인준/현수→선희).
export function contrastEdgeVoice(baseId?: string, language?: string): string {
  const base = (baseId || defaultEdgeVoice(language)).split('#')[0];
  const prefix = (language || 'ko-KR').toLowerCase().split('-')[0];
  const cand = EDGE_VOICES.find(
    (v) => !v.id.includes('#') && v.language.toLowerCase().startsWith(prefix) && v.id !== base,
  );
  return cand ? cand.id : base;
}
