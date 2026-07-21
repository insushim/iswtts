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
    // v1.27.0: 두 주어가 있어도 "발화 동사 직전의 가장 가까운 단서"가 화자다 —
    // "그가 말하자 그녀가 웃었다"에서 대사를 한 사람은 그. (구 스펙은 null=중립 폴백)
    expect(guessDialogueGender('"그래." 그가 말하자 그녀가 웃었다.')).toBe('male');
    // 발화 동사가 없으면 여전히 판별 불가(넘겨짚지 않는다).
    expect(guessDialogueGender('"그래." 그가 일어서자 그녀가 웃었다.')).toBeNull();
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
  test('여격(청자)·서술어 꼴은 화자 단서 아님', () => {
    expect(guessDialogueGender('"안녕." 철수가 그녀에게 말했다.')).toBeNull();
    expect(guessDialogueGender('"좋아." 그날따라 여자였다.')).toBeNull();
  });
  // v1.27.0 스펙 변경: 관형(소유격)이라도 "뒤에 발화 명사가 오면" 화자 표지로 인정한다 —
  // "어머니의 목소리가 들렸다"의 화자는 어머니다(구 스펙은 통째로 버려 중립 폴백).
  // 발화 명사가 아니면 종전대로 단서 아님("어머니의 손을 잡았다" = 화자 아님).
  test('소유격 + 발화 명사는 화자 표지(v1.27.0)', () => {
    expect(guessDialogueGender('"응." 어머니의 목소리가 들렸다.')).toBe('female');
    expect(guessDialogueGender('"가자." 사내의 말이 짧았다.')).toBe('male');
    expect(guessDialogueGender('"응." 그는 어머니의 손을 잡았다.')).toBe('male');
  });
  test('주격 단서는 계속 인식', () => {
    expect(guessDialogueGender('"안녕." 그녀가 손을 흔들었다.')).toBe('female');
    expect(guessDialogueGender('"가자." 사내는 앞장섰다.')).toBe('male');
  });
});

describe('guessDialogueGenders — 2패스 인접 문장 단서(v1.25.3)', () => {
  const { guessDialogueGenders } = require('../lib/speakerGender');
  test('화자 소개(앞 지문) → 이어지는 통짜 대사에 전파', () => {
    const g = guessDialogueGenders(['사내가 입을 열었다.', '"오랜만이군."']);
    expect(g[1]).toBe('male');
  });
  test('꼬리표 후행(다음 지문) 전파', () => {
    const g = guessDialogueGenders(['"어서 오렴."', '어머니는 문을 열어 주었다.']);
    expect(g[0]).toBe('female');
  });
  test('연속 대화 구간(양쪽 다 대사)은 확장하지 않는다', () => {
    const g = guessDialogueGenders(['사내가 물었다.', '"왔나?"', '"네."', '"앉게."']);
    expect(g[1]).toBe('male'); // 소개 직후 1건만
    expect(g[2]).toBeNull(); // 교대 화자 넘겨짚기 금지
  });
  test('자기 문장 단서가 항상 우선', () => {
    const g = guessDialogueGenders(['사내가 말했다.', '"그래." 그녀가 답했다.']);
    expect(g[1]).toBe('female');
  });
});

describe('탐색 창 2문장(v1.27.0)', () => {
  const { guessDialogueGenders } = require('../lib/speakerGender');
  test('화자 소개와 대사 사이에 지문이 한 줄 더 껴도 이어받는다', () => {
    const s = ['사내가 문을 열었다.', '잠시 망설였다.', '"누구요?"'];
    expect(guessDialogueGenders(s)[2]).toBe('male');
  });
  test('창 밖(3문장 이상 떨어짐)이면 넘겨짚지 않는다', () => {
    const s = ['사내가 문을 열었다.', '잠시 망설였다.', '바람이 불었다.', '"누구요?"'];
    expect(guessDialogueGenders(s)[3]).toBeNull();
  });
  test('중간에 다른 대사가 끼면 중단(화자 교대 가능성)', () => {
    const s = ['사내가 문을 열었다.', '"거기 누구요?"', '"저예요."'];
    expect(guessDialogueGenders(s)[2]).toBeNull();
  });
});

describe('발화 동사 다중/동음이의 방어(교차검증 Gemini 재현 2026-07-21)', () => {
  const { guessDialogueGender, guessDialogueGenders } = require('../lib/speakerGender');
  test('"물다(bite)"가 섞인 문장은 넘겨짚지 않는다(구현은 정반대로 귀속했었다)', () => {
    expect(guessDialogueGender('"그래." 그녀가 사과를 베어 물었고 그가 말했다.')).toBeNull();
    expect(guessDialogueGender('"그래." 그가 사과를 베어 물었고 그녀가 말했다.')).toBeNull();
  });
  test('종속절+주절에 발화 동사가 둘이면 null', () => {
    expect(guessDialogueGender('"응." 어머니가 말하자 그가 물었다.')).toBeNull();
  });
  test('발화 동사가 하나면 종전대로 최근접 단서 채택', () => {
    expect(guessDialogueGender('"그래." 그가 어머니에게 말했다.')).toBe('male');
  });
  test('문단(장면) 경계를 넘어 성별이 전파되지 않는다', () => {
    const s = ['사내가 문을 열었다.', '"누구요?"'];
    expect(guessDialogueGenders(s)[1]).toBe('male'); // 같은 문단
    expect(guessDialogueGenders(s, new Set([1]))[1]).toBeNull(); // 새 문단의 첫 대사
  });
});
