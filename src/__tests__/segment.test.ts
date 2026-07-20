import { segmentSentences } from '../lib/segment';

describe('segmentSentences (한국어 문장 분할)', () => {
  it('기본 분할: 종결부호+공백 기준', () => {
    const out = segmentSentences('첫 문장입니다. 두 번째 문장입니다! 세 번째인가요? 네.');
    expect(out).toEqual(['첫 문장입니다.', '두 번째 문장입니다!', '세 번째인가요?', '네.']);
  });

  it('대사+지문은 한 문장으로 유지(v1.25.1 스펙 변경 — 구 동작이 사용자 보고 오분할)', () => {
    const out = segmentSentences('"안녕하세요." 그가 말했다.');
    expect(out).toEqual(['"안녕하세요." 그가 말했다.']);
  });

  it('소수점은 분할하지 않음 (3.5% 등)', () => {
    const out = segmentSentences('금리가 3.5%로 올랐다. 시장이 반응했다.');
    expect(out).toEqual(['금리가 3.5%로 올랐다.', '시장이 반응했다.']);
  });

  it('문단(개행) 경계 유지', () => {
    const out = segmentSentences('첫 문단\n\n둘째 문단');
    expect(out).toEqual(['첫 문단', '둘째 문단']);
  });

  it('긴 문장은 MAX_LEN(280) 이하로 강제 분할', () => {
    const long = '가나다라마 '.repeat(100).trim() + '.';
    const out = segmentSentences(long);
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(280);
    // 내용 유실 없음(공백 제외 총 글자수 보존)
    expect(out.join('').replace(/\s/g, '')).toBe(long.replace(/\s/g, ''));
  });

  it('빈 입력·공백만 입력', () => {
    expect(segmentSentences('')).toEqual([]);
    expect(segmentSentences('   \n\n  ')).toEqual([]);
  });
});

describe('소설 텍스트 오분할 방지(v1.25.1 — 사용자 "한 문장을 막 나눠 읽음" 보고)', () => {
  const { segmentSentences } = require('../lib/segment');
  test('대사+지문은 한 문장(닫는 따옴표 안 종결부호는 경계 아님)', () => {
    expect(segmentSentences('"가자." 그가 말했다.')).toEqual(['"가자." 그가 말했다.']);
    expect(segmentSentences('"어디 가?" 하고 어머니가 물었다.')).toEqual([
      '"어디 가?" 하고 어머니가 물었다.',
    ]);
    expect(segmentSentences('“멈춰!” 사내가 소리치며 달려왔다.')).toEqual([
      '“멈춰!” 사내가 소리치며 달려왔다.',
    ]);
  });
  test('문장 중간 말줄임은 경계 아님, 새 발화(여는 따옴표) 앞에서만 경계', () => {
    expect(segmentSentences('그는… 조용히 걸었다.')).toEqual(['그는… 조용히 걸었다.']);
    expect(segmentSentences('할 말이 있었다… "미안해."')).toEqual([
      '할 말이 있었다…',
      '"미안해."',
    ]);
  });
  test('날짜·장 번호 마침표는 파편으로 쪼개지 않는다(숫자 오독의 원인)', () => {
    expect(segmentSentences('1945. 8. 15. 그날의 아침이었다.')).toEqual([
      '1945. 8. 15. 그날의 아침이었다.',
    ]);
    expect(segmentSentences('1. 서장')).toEqual(['1. 서장']);
    expect(segmentSentences('12. 귀향')).toEqual(['12. 귀향']);
  });
  test('평범한 종결은 종전대로 분할', () => {
    expect(segmentSentences('밤이 깊었다. 바람이 불었다. 그는 떠났다.')).toEqual([
      '밤이 깊었다.',
      '바람이 불었다.',
      '그는 떠났다.',
    ]);
    expect(segmentSentences('정말일까? 아무도 몰랐다!')).toEqual([
      '정말일까?',
      '아무도 몰랐다!',
    ]);
  });
  test('소수·쉼표 수는 종전대로 안전(마침표가 공백 앞이 아님)', () => {
    expect(segmentSentences('체온은 36.5도였다. 정상이다.')).toEqual([
      '체온은 36.5도였다.',
      '정상이다.',
    ]);
  });
});

describe('교차검증 반영(v1.25.1): 낫표·연속 대사·따옴표 누출', () => {
  const { segmentSentences } = require('../lib/segment');
  test('낫표 대사+지문도 한 문장, 다음 문장은 정상 분할', () => {
    expect(segmentSentences('「가자.」 그가 말했다. 밤이 깊었다.')).toEqual([
      '「가자.」 그가 말했다.',
      '밤이 깊었다.',
    ]);
  });
  test('연속 대사는 발화 단위로 분리("왔니?" "응.")', () => {
    expect(segmentSentences('"왔니?" "응, 왔어." 그가 웃었다.')).toEqual([
      '"왔니?"',
      '"응, 왔어." 그가 웃었다.',
    ]);
  });
});

describe('다중 문장 대사(교차검증 Claude 지적 — 인용 스팬 추적)', () => {
  const { segmentSentences } = require('../lib/segment');
  test('대사 안쪽 종결부호는 경계 아님(여는 따옴표 고아 방지)', () => {
    expect(segmentSentences('「첫 문장이다. 둘째 문장이다.」 그가 말했다.')).toEqual([
      '「첫 문장이다. 둘째 문장이다.」 그가 말했다.',
    ]);
    expect(segmentSentences('"떠나자. 지금 당장." 그녀가 말했다. 밤이 깊었다.')).toEqual([
      '"떠나자. 지금 당장." 그녀가 말했다.',
      '밤이 깊었다.',
    ]);
  });
  test('짝 잃은 따옴표는 폭주하지 않는다(일반 분할 유지)', () => {
    expect(segmentSentences('그는 "라고 말했다. 밤이 깊었다. 바람이 불었다.')).toEqual([
      '그는 "라고 말했다.',
      '밤이 깊었다.',
      '바람이 불었다.',
    ]);
  });
});

test('병리 반복 입력("1. 1. …")에 선형 시간(교차검증 codex — O(n²) 방지)', () => {
  const { splitLineToSentences } = require('../lib/segment');
  const line = Array(4000).fill('1. ').join('') + '끝';
  const t0 = Date.now();
  splitLineToSentences(line);
  expect(Date.now() - t0).toBeLessThan(500);
});

describe('하드랩 재조립(v1.25.2 — 고정폭 txt에서 문장/단어 중간 줄바꿈)', () => {
  const { segmentDocument, segmentSentences } = require('../lib/segment');
  test('문단 안 줄들은 이어붙여 의미 단위로 분할(단어 중간 랩 포함)', () => {
    const raw = '저만의 무예를 만들 것입니\n다. 스승은 고개를 끄덕였다.';
    expect(segmentSentences(raw)).toEqual([
      '저만의 무예를 만들 것입니 다.',
      '스승은 고개를 끄덕였다.',
    ]);
  });
  test('문장이 줄 경계를 넘는 일반 하드랩', () => {
    const raw = '노인은 낡은 외투 깃을 세우고\n골목 끝의 서점으로 걸음을 옮겼다.\n밤이 깊었다.';
    expect(segmentSentences(raw)).toEqual([
      '노인은 낡은 외투 깃을 세우고 골목 끝의 서점으로 걸음을 옮겼다.',
      '밤이 깊었다.',
    ]);
  });
  test('문단(빈 줄) 경계와 paraStarts는 보존', () => {
    const { sentences, paraStarts } = segmentDocument('첫 문단 첫 문장.\n이어진 둘째 문장.\n\n둘째 문단이다.');
    expect(sentences).toEqual(['첫 문단 첫 문장.', '이어진 둘째 문장.', '둘째 문단이다.']);
    expect(paraStarts).toEqual([0, 2]);
  });
});
