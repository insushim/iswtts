// 대사 화자 성별 추정(순수 함수 — 테스트 대상). "대사는 다른 목소리로" 기능의 자동 대비를
// 남/여까지 구분해 준다(사용자 요청 2026-07-20 "남자 구분해줄 수 있나").
//
// 방법: 대사(따옴표 안)를 지우고 남은 지문에서 성별 단서 어휘를 찾는다 — 소설 관행상
// 대사 문장의 지문("…" 그가 말했다 / 어머니가 웃으며 …)에 화자가 명시되는 경우가 많다.
// v1.25.1 의 문장 분할 수정(대사+지문 = 한 문장)이 전제 — 그 전엔 지문이 다른 문장으로
// 떨어져 나가 단서를 볼 수 없었다.
//
// 한계(설계상 허용): 지문 없는 연속 대화(「"왔니?" "응."」)나 이름만 있는 화자("지수가
// 말했다")는 판별 불가 → null 을 돌려주고 호출부가 기존 자동 대비(중립)로 폴백한다.
// 두 성별 단서가 같이 있으면("그가 어머니에게 말했다") 오귀속 위험이 커 null.

// 인용 스팬 제거용. dialogue.ts 의 대사 짝(큰따옴표 계열)보다 넓게 — 홑따옴표(생각)·
// 겹낫표(제목)도 지운다: 그 안의 성별 어휘("'그녀를 봤어?' 하고 물었다")가 지문 판정에
// 새면 오귀속된다(교차검증 Gemini 지적, 실측 재현 확인 2026-07-20).
const QUOTE_SPANS = /“[^”]*”|"[^"]*"|「[^」]*」|‘[^’]*’|'[^']*'|『[^』]*』/g;

// 지문 성별 단서. 호칭·지칭 명사는 소설 지문에서 화자 표지로 쓰이는 빈도 높은 것만 —
// 과욕(이름 사전 등)은 오귀속을 늘린다.
// 주격류 조사(가/이/는/은/도)가 바로 뒤따를 때만 단서로 인정: "철수가 그녀에게 말했다"의
// "그녀에게"(여격=청자)를 화자로 오인하지 않게(교차검증 codex 지적, 실측 재현). 부수 효과로
// "그녀석"(그+녀석)·"여자였다"(서술어) 같은 비주어 꼴도 걸러진다.
const FEMALE_CUES =
  /(그녀|여자|소녀|여인|아주머니|아줌마|할머니|어머니|엄마|아내|부인|아가씨|언니|누나|누이)(?=[가이는은도])/;
const MALE_CUES =
  /(사내|남자|소년|아저씨|할아버지|아버지|아빠|남편|영감|청년|형님|오라버니)(?=[가이는은도])/;
// 3인칭 남성 대명사 "그가/그는/그도" — "그날/그때" 같은 지시어와 구분하려고 조사까지 본다.
// ("그녀가"는 그+녀 라서 이 패턴에 걸리지 않는다.)
const HE_PRONOUN = /(^|[^가-힣])그[가는도](?=[^가-힣]|$)/;

export type SpeakerGender = 'male' | 'female';

export function guessDialogueGender(sentence: string): SpeakerGender | null {
  const narration = sentence.replace(QUOTE_SPANS, ' ');
  if (!narration.trim()) return null; // 지문 없음(통짜 대사)
  const female = FEMALE_CUES.test(narration);
  const male = MALE_CUES.test(narration) || HE_PRONOUN.test(narration);
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return null; // 단서 없음 또는 양쪽 다(모호) — 호출부가 중립 대비로 폴백
}

// 문서 단위 2패스 추정(v1.25.3 — "남녀 구분이 잘 안 된다" 후속). 소설 대사의 다수는
// 같은 문장에 지문이 없다(대사만 한 문단/이름만 있는 꼬리표) — 1패스가 null 이면:
//   앞 문장이 대사 없는 순수 지문이고 성별 단서가 있으면 그걸 쓴다("사내가 입을 열었다."
//   → 다음 줄 대사 = 화자 소개 관행) → 없으면 다음 문장 지문(꼬리표 후행 관행)을 본다.
// 대화가 이어지는 구간(양쪽 다 대사)은 확장하지 않는다 — 교대 화자를 넘겨짚으면 절반이
// 오귀속이라 null(폴백)이 낫다.
export function guessDialogueGenders(sentences: string[]): Array<SpeakerGender | null> {
  const hasQuote = sentences.map((s) => {
    QUOTE_SPANS.lastIndex = 0;
    return QUOTE_SPANS.test(s);
  });
  const own = sentences.map(guessDialogueGender);
  return sentences.map((s, i) => {
    if (own[i]) return own[i];
    if (!hasQuote[i]) return null; // 지문 문장 자체는 확장 대상 아님
    const prev = i > 0 && !hasQuote[i - 1] ? own[i - 1] : null;
    if (prev) return prev;
    const next = i + 1 < sentences.length && !hasQuote[i + 1] ? own[i + 1] : null;
    return next;
  });
}

// Supertonic 3 화자(sid 0~9)의 성별 — F0 자기상관 실측(2026-07-20, sid_gender.py):
// 0~4 = 여(172~253Hz), 5~9 = 남(85~151Hz). Supertone 배포의 voice_styles F1~F5/M1~M5
// 명명과 일치. 배열 순서 = 대사 음성으로 고를 때의 선호 순(음색 대비가 또렷한 순).
export const SHERPA_FEMALE_SIDS = ['1', '3', '2', '4', '0'];
export const SHERPA_MALE_SIDS = ['6', '7', '8', '5', '9'];
