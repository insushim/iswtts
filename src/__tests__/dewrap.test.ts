import {
  tokenCore,
  buildWrapVocab,
  looksCharWrapped,
  mergeAcrossWrap,
  joinWrappedLines,
  buildRepairIndex,
  repairFakeSpaces,
} from '../lib/dewrap';

// 고정폭 하드랩 복원 스펙(v1.27.3) — "자 신도"·"앉 아" 같은 원문에 없는 공백을 만들지 않는다.

describe('tokenCore', () => {
  test('앞뒤 구두점·따옴표를 벗긴다', () => {
    expect(tokenCore('“자신도')).toBe('자신도');
    expect(tokenCore('있었다.”')).toBe('있었다');
    expect(tokenCore('명령체계에')).toBe('명령체계에');
  });
});

describe('buildWrapVocab', () => {
  test('줄의 첫·끝 토큰은 어휘에 넣지 않는다(랩에 잘렸을 수 있는 자리)', () => {
    const v = buildWrapVocab(['가나 다라 마바', '사아 자차 카타']);
    expect(v.has('다라')).toBe(true);
    expect(v.has('가나')).toBe(false);
    expect(v.has('마바')).toBe(false);
  });
  test('1글자 토큰은 어휘가 아니다', () => {
    const v = buildWrapVocab(['가나 다 마바']);
    expect(v.has('다')).toBe(false);
  });
});

describe('looksCharWrapped', () => {
  const uniform = Array.from({ length: 12 }, (_, i) => 'ㄱ'.repeat(40 - (i % 2)));
  test('길이가 한 폭에 몰려 있으면 문자수 랩', () => {
    expect(looksCharWrapped(uniform)).toBe(true);
  });
  test('어절 단위 랩(길이 들쭉날쭉)은 아니다', () => {
    const varied = [30, 38, 25, 39, 33, 21, 37, 28, 31, 36].map((n) => 'ㄱ'.repeat(n));
    expect(looksCharWrapped(varied)).toBe(false);
  });
  test('표본이 적으면(12줄 미만) 판단하지 않는다 — 감지는 자동 적용의 충분조건', () => {
    expect(looksCharWrapped(uniform.slice(0, 11))).toBe(false);
  });
  test('폭이 꽉 찬 줄이 종결부호로 끝나면(한 줄=한 문장 파일) 판단 보류', () => {
    const perSentence = Array.from({ length: 14 }, () => 'ㄱ'.repeat(39) + '.');
    expect(looksCharWrapped(perSentence)).toBe(false);
  });
  test('아주 긴 줄(200자 초과)은 랩이 아니라 원래 긴 줄', () => {
    expect(looksCharWrapped(Array.from({ length: 12 }, () => 'ㄱ'.repeat(300)))).toBe(false);
  });
});

describe('mergeAcrossWrap', () => {
  const vocab = buildWrapVocab([
    '그는 자신도 모르게 웃었다 그때',
    '무리의 명령체계에 혼선이 생겼다 곧',
    '나는 혼자인데 적은 수십이다 그래도',
  ]);
  test('R2 — 이어붙인 형태가 문서에 있으면 붙인다', () => {
    expect(mergeAcrossWrap('자', '신도', vocab)).toBe(true);
    expect(mergeAcrossWrap('명', '령체계에', vocab)).toBe(true);
  });
  test('둘 다 문서에 있는 정상 어절이면 띄운다', () => {
    expect(mergeAcrossWrap('나는', '혼자인데', vocab)).toBe(false);
  });
  test('R1 — 닫는 구두점 앞엔 공백이 없다', () => {
    expect(mergeAcrossWrap('갈라졌다', '.', vocab)).toBe(true);
    expect(mergeAcrossWrap('번득이고', ',', vocab)).toBe(true);
  });
  test('여는 따옴표로 시작하거나 앞이 구두점으로 끝나면 붙이지 않는다', () => {
    expect(mergeAcrossWrap('말했다.', '“가자', vocab)).toBe(false);
    expect(mergeAcrossWrap('자', '“신도', vocab)).toBe(false);
  });
  test('한글 없는 장식선·기호는 붙이지 않는다', () => {
    expect(mergeAcrossWrap('═══', '═══', vocab)).toBe(false);
  });
});

describe('joinWrappedLines', () => {
  const vocab = buildWrapVocab(['그는 자신도 모르게 웃었다 하지만']);
  test('어휘가 없으면(문자수 랩 미감지) 종전대로 전부 공백', () => {
    expect(joinWrappedLines(['그는 자', '신도 몰랐다'], [false, false], null)).toBe(
      '그는 자 신도 몰랐다',
    );
  });
  test('문자수 랩이면 어휘로 붙인다', () => {
    expect(joinWrappedLines(['그는 자', '신도 몰랐다'], [false, false], vocab)).toBe(
      '그는 자신도 몰랐다',
    );
  });
  test('R0 — 원본 줄이 공백으로 끝났으면 확실한 어절 경계', () => {
    expect(joinWrappedLines(['그는 자', '신도 몰랐다'], [true, false], vocab)).toBe(
      '그는 자 신도 몰랐다',
    );
  });
  test('어미 조각도 문서 어휘로 붙는다', () => {
    const v = buildWrapVocab(['나는 생각합니다 그러니까 늘 생각합니다 그렇다']);
    expect(joinWrappedLines(['그렇게 생각합니', '다. 정말로'], [false, false], v)).toBe(
      '그렇게 생각합니다. 정말로',
    );
  });
  test('빈 입력', () => {
    expect(joinWrappedLines([], [], vocab)).toBe('');
  });
});

describe('repairFakeSpaces(저장본 사후 복원)', () => {
  const stored = [
    '그는 자신도 모르게 웃었다.',
    '자 신도 모르는 사이에 벌어진 일이다.',
    '자신도 어쩔 수 없었다.',
  ];
  const idx = buildRepairIndex(stored);
  test('문서에 2회 이상 등장하는 형태로 붙는다', () => {
    expect(repairFakeSpaces(stored[1], idx)).toBe('자신도 모르는 사이에 벌어진 일이다.');
  });
  test('정상 문장은 그대로', () => {
    expect(repairFakeSpaces(stored[0], idx)).toBe(stored[0]);
  });
  test('구두점 앞 공백은 항상 제거', () => {
    expect(repairFakeSpaces('그는 웃었다 .', idx)).toBe('그는 웃었다.');
  });
  test('토큰이 하나면 손대지 않는다', () => {
    expect(repairFakeSpaces('네.', idx)).toBe('네.');
  });
  test('근거(빈도)가 없으면 붙이지 않는다 — 문장 수·순서 불변이 원칙', () => {
    expect(repairFakeSpaces('처음 보는 어절 조합이다.', idx)).toBe('처음 보는 어절 조합이다.');
  });
});

// ── 마이그레이션 안전 불변식(v1.27.3) ──────────────────────────────
// library.loadDoc 이 구버전 문서를 열 때 sentences.map(repairFakeSpaces) 로 1회 복원한다.
// 읽던 위치(lastIndex)가 보존되는 근거는 오직 "문장 수·순서가 변하지 않는다"는 이 성질이다
// (교차검증 Claude: 재분할+인덱스 리매핑은 전 사용자 위치가 조용히 틀어지는 CRITICAL 급).
describe('복원은 문장 배열의 모양을 바꾸지 않는다', () => {
  const doc = [
    '자 신도 모르는 사이에 일이 벌어졌다.',
    '그는 자신도 어쩔 수 없었다.',
    '"무공" 을 익힌 자였다.',
    '네.',
    '……',
    '자신도 모르게 웃었다.',
  ];
  const idx = buildRepairIndex(doc);
  const out = doc.map((s) => repairFakeSpaces(s, idx));

  test('문장 수·순서 불변(= lastIndex 보존)', () => {
    expect(out.length).toBe(doc.length);
    expect(out[3]).toBe('네.');
  });
  test('빈 문장을 만들지 않는다(빈 자막·무음 발화 방지)', () => {
    for (const s of out) expect(s.trim().length).toBeGreaterThan(0);
  });
  test('공백만 사라질 뿐 글자는 그대로(낭독 유실 0)', () => {
    for (let i = 0; i < doc.length; i++) {
      expect(out[i].replace(/\s+/g, '')).toBe(doc[i].replace(/\s+/g, ''));
    }
  });
  test('멱등 — 다시 돌려도 같은 결과', () => {
    const twice = out.map((s) => repairFakeSpaces(s, buildRepairIndex(out)));
    expect(twice).toEqual(out);
  });
});
