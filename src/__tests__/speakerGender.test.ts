describe('guessDialogueGender — 대사 화자 성별 추정(v1.25.1)', () => {
  const { guessDialogueGender, SHERPA_FEMALE_SIDS, SHERPA_MALE_SIDS } = require('../lib/speakerGender');
  test('지문의 남성 단서', () => {
    expect(guessDialogueGender('"가자." 그가 말했다.')).toBe('male');
    expect(guessDialogueGender('"멈춰!" 사내가 소리쳤다.')).toBe('male');
    expect(guessDialogueGender('"밥 먹었니?" 아버지가 물었다.')).toBe('male');
    expect(guessDialogueGender('“알겠습니다.” 청년이 고개를 숙였다.')).toBe('male');
  });
  test('지문의 여성 단서', () => {
    expect(guessDialogueGender('"싫어." 그녀가 속삭였다.')).toBe('female');
    expect(guessDialogueGender('"어서 오렴." 어머니가 웃었다.')).toBe('female');
    expect(guessDialogueGender('"조심하거라." 할머니는 손을 흔들었다.')).toBe('female');
  });
  test('판별 불가 → null(중립 대비 폴백)', () => {
    expect(guessDialogueGender('"왔니?" "응."')).toBeNull(); // 지문 없음
    expect(guessDialogueGender('"응." 지수가 답했다.')).toBeNull(); // 이름만
    // 주격 조사 제약 도입(codex 반영) 후 "어머니에게"(청자)는 단서에서 제외돼 화자(그가)만
    // 남는다 — 구 스펙(양쪽 단서 → null)보다 정확해진 케이스.
    expect(guessDialogueGender('"그래." 그가 어머니에게 말했다.')).toBe('male');
    // 진짜 모호(두 주어): 여전히 null
    expect(guessDialogueGender('"그래." 그가 말하자 그녀가 웃었다.')).toBeNull();
  });
  test('함정: 대사 안의 단서·지시어 "그날"은 무시', () => {
    expect(guessDialogueGender('"그녀가 왔다고?" 라고 외치는 소리가 들렸다.')).toBeNull();
    expect(guessDialogueGender('"좋아." 그날따라 목소리가 낮았다.')).toBeNull();
  });
  test('sid 성별 상수: 겹침 없이 0~9 전부, 실측 구획(0~4 여/5~9 남)', () => {
    const all = [...SHERPA_FEMALE_SIDS, ...SHERPA_MALE_SIDS].sort();
    expect(all).toEqual(['0','1','2','3','4','5','6','7','8','9']);
    expect(SHERPA_FEMALE_SIDS.every((s: string) => Number(s) <= 4)).toBe(true);
    expect(SHERPA_MALE_SIDS.every((s: string) => Number(s) >= 5)).toBe(true);
  });
});

describe('따옴표 누출 방지(교차검증 Gemini CONFIRMED)', () => {
  const { guessDialogueGender } = require('../lib/speakerGender');
  test('홑따옴표(생각)·겹낫표(제목) 안의 단서는 무시', () => {
    expect(guessDialogueGender("'그녀를 봤어?' 하고 물었다.")).toBeNull();
    expect(guessDialogueGender('『그녀의 정원』을 읽으며 사내가 말했다.')).toBe('male');
  });
});

describe('주격 조사 제약(교차검증 codex CONFIRMED)', () => {
  const { guessDialogueGender } = require('../lib/speakerGender');
  test('여격(청자)·관형·서술어 꼴은 화자 단서 아님', () => {
    expect(guessDialogueGender('"안녕." 철수가 그녀에게 말했다.')).toBeNull();
    expect(guessDialogueGender('"응." 어머니의 목소리가 들렸다.')).toBeNull();
  });
  test('주격 단서는 계속 인식', () => {
    expect(guessDialogueGender('"안녕." 그녀가 손을 흔들었다.')).toBe('female');
    expect(guessDialogueGender('"가자." 사내는 앞장섰다.')).toBe('male');
  });
});
