import { normalizeForSpeech, readSino, readNative } from '../tts/sherpa/normalizeKo';

// 발화 정규화 스펙 — Supertonic 이 못 읽는 숫자·기호·괄호 한자를 확실한 한글로 푼다.
// (오독 실측 2026-07-18: "12,500원"→"칠천 오번", "85%"→"버서쇠", 沙果→중국어 발음.)

describe('readSino(한자어 수)', () => {
  test.each<[string, string]>([
    ['0', '영'],
    ['3', '삼'],
    ['10', '십'],
    ['12', '십이'],
    ['100', '백'],
    ['1948', '천구백사십팔'],
    ['10000', '만'],
    ['12500', '만이천오백'],
    ['100000000', '일억'],
    ['100010000', '일억일만'], // 억 아래 중간 자리의 만은 "일" 유지(교차검증 발견 — "일억만" 오독 방지)
    ['123456789', '일억이천삼백사십오만육천칠백팔십구'],
  ])('%s → %s', (input, expected) => {
    expect(readSino(input)).toBe(expected);
  });
});

describe('readNative(고유어 수관형사)', () => {
  test.each<[number, string | null]>([
    [1, '한'],
    [2, '두'],
    [3, '세'],
    [4, '네'],
    [8, '여덟'],
    [10, '열'],
    [20, '스무'],
    [21, '스물한'],
    [35, '서른다섯'],
    [99, '아흔아홉'],
    [100, null], // 100 이상은 한자어 폴백
    [0, null],
  ])('%d → %s', (input, expected) => {
    expect(readNative(input)).toBe(expected);
  });
});

describe('normalizeForSpeech', () => {
  test('단위별 고유어/한자어 분담', () => {
    expect(normalizeForSpeech('사과 3개와 배 12개를 샀다.')).toBe('사과 세개와 배 열두개를 샀다.');
    expect(normalizeForSpeech('두 사람이 8살 아이와 왔다.')).toBe('두 사람이 여덟살 아이와 왔다.');
    expect(normalizeForSpeech('그 책은 1948년에 출간되었다.')).toBe('그 책은 천구백사십팔년에 출간되었다.');
    expect(normalizeForSpeech('제2차 세계대전은 1945년에 끝났다.')).toBe(
      '제이차 세계대전은 천구백사십오년에 끝났다.',
    );
  });

  test('시각: 시는 고유어, 분은 한자어', () => {
    expect(normalizeForSpeech('3시 30분에 만나자.')).toBe('세시 삼십분에 만나자.');
    expect(normalizeForSpeech('낭독은 2시간 걸렸다.')).toBe('낭독은 두시간 걸렸다.');
    // "언제"의 '제'는 서수 접두가 아니다.
    expect(normalizeForSpeech('언제 2시에 볼까?')).toBe('언제 두시에 볼까?');
  });

  test('월 이름 관례(유월·시월)', () => {
    expect(normalizeForSpeech('10월 9일은 한글날이다.')).toBe('시월 구일은 한글날이다.');
    expect(normalizeForSpeech('6월 25일')).toBe('유월 이십오일');
    expect(normalizeForSpeech('12월 1일')).toBe('십이월 일일');
  });

  test('쉼표 수·소수·퍼센트', () => {
    expect(normalizeForSpeech('가격은 12,500원이었다.')).toBe('가격은 만이천오백원이었다.');
    expect(normalizeForSpeech('온도가 36.5도까지 올랐다.')).toBe('온도가 삼십육 점 오도까지 올랐다.');
    expect(normalizeForSpeech('약 85%의 학생이 찬성했다.')).toBe('약 팔십오퍼센트의 학생이 찬성했다.');
    expect(normalizeForSpeech('원주율은 3.14다.')).toBe('원주율은 삼 점 일사다.');
  });

  test('한자어 복합 단위는 고유어로 오분류하지 않는다', () => {
    expect(normalizeForSpeech('3개월 뒤에 만나자.')).toBe('삼개월 뒤에 만나자.');
    expect(normalizeForSpeech('우리 집은 7번지다.')).toBe('우리 집은 칠번지다.');
    // 반대로 "번"(횟수)은 고유어.
    expect(normalizeForSpeech('같은 실수를 3번 반복했다.')).toBe('같은 실수를 세번 반복했다.');
  });

  test('괄호 한자 주석 제거(중국어 발음 방지)', () => {
    expect(normalizeForSpeech('그는 사과(沙果)를 좋아했다.')).toBe('그는 사과를 좋아했다.');
    expect(normalizeForSpeech('학교(學校)에서 공부한다.')).toBe('학교에서 공부한다.');
    expect(normalizeForSpeech('전각 괄호（漢字）도 지운다.')).toBe('전각 괄호도 지운다.');
    // 한자가 아닌 괄호 내용(한글·영문·숫자)은 그대로 읽는다.
    expect(normalizeForSpeech('그 회사(삼성)는 크다.')).toBe('그 회사(삼성)는 크다.');
  });

  test('전화번호·선행 0·범위(교차검증 발견 케이스)', () => {
    expect(normalizeForSpeech('문의는 010-1234-5678로 주세요.')).toBe(
      '문의는 공일공 일이삼사 오육칠팔로 주세요.',
    );
    expect(normalizeForSpeech('요원 007이 왔다.')).toBe('요원 공공칠이 왔다.');
    expect(normalizeForSpeech('사과를 1~2개 먹어라.')).toBe('사과를 일에서 두개 먹어라.');
    expect(normalizeForSpeech('1950~60년대의 일이다.')).toBe('천구백오십에서 육십년대의 일이다.');
  });

  test('한자+숫자 혼합 괄호도 제거(교차검증 발견)', () => {
    expect(normalizeForSpeech('그 해(2026年) 겨울이었다.')).toBe('그 해 겨울이었다.');
    // 중첩 괄호는 2패스로 정리(안쪽부터 벗겨짐).
    expect(normalizeForSpeech('묘한 표기(漢(字))다.')).toBe('묘한 표기다.');
  });

  test('2차 교차검증 발견 케이스: 소수 0.x·짧은 하이픈 범위·단위 오탐', () => {
    expect(normalizeForSpeech('농도가 0.5도 올랐다.')).toBe('농도가 영 점 오도 올랐다.');
    // 뒤 숫자는 단위(번=고유어)를 그대로 타서 "다섯번" — 자연스러운 읽기.
    expect(normalizeForSpeech('3-5번 문제를 풀어라.')).toBe('삼에서 다섯번 문제를 풀어라.');
    expect(normalizeForSpeech('2002 월드컵과 6월드컵은 다르다.')).toBe(
      '이천이 월드컵과 육월드컵은 다르다.',
    );
    expect(normalizeForSpeech('기원전 3시대 구분이다.')).toBe('기원전 삼시대 구분이다.');
  });

  test('숫자 없는 문장은 불변·멱등', () => {
    const s = '바람이 몹시 차가운 밤이었다.';
    expect(normalizeForSpeech(s)).toBe(s);
    const t = '사과 3개와 배 12개를 샀다.';
    expect(normalizeForSpeech(normalizeForSpeech(t))).toBe(normalizeForSpeech(t));
  });
});

describe('날짜 연쇄(v1.25.1 — "1945. 8. 15." 파편 낭독 방지)', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  test('연.월.일 → 년/월/일 낭독', () => {
    expect(normalizeForSpeech('1945. 8. 15. 그날의 아침이었다.')).toBe(
      '천구백사십오년 팔월 십오일 그날의 아침이었다.',
    );
    expect(normalizeForSpeech('2026. 12. 31.')).toBe('이천이십육년 십이월 삼십일일');
  });
  test('소수·번호 나열은 오인하지 않음', () => {
    expect(normalizeForSpeech('체온 36.5도.')).toBe('체온 삼십육 점 오도.');
    // 13 이상은 월이 아니라 변환 안 함(그룹별 그대로)
    expect(normalizeForSpeech('1945. 13. 20.')).not.toContain('년');
  });
});

test('날짜 뒤 조사("2026. 12. 31.에")도 정규화(교차검증 CONFIRMED)', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  expect(normalizeForSpeech('2026. 12. 31.에 만나자.')).toBe('이천이십육년 십이월 삼십일일에 만나자.');
});

test('일 표기 중복·0일 방지(교차검증 codex CONFIRMED)', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  expect(normalizeForSpeech('2026. 12. 31일에 만나자.')).toBe('이천이십육년 십이월 삼십일일에 만나자.');
  expect(normalizeForSpeech('2026. 12. 0.')).not.toContain('년');
});

test('권은 한자어("1권"=일권 — 소설 권수 표기, 사용자 지적 v1.25.2)', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  expect(normalizeForSpeech('1권을 읽었다.')).toBe('일권을 읽었다.');
  expect(normalizeForSpeech('제3권이 나왔다.')).toBe('제삼권이 나왔다.');
});

describe('한자 낭독 금지 일반화(v1.25.3 — 사용자 "괄호 안의 한자는 읽지 말자")', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  test('대괄호·꺾쇠 등 다른 괄호의 한자 주석도 제거', () => {
    expect(normalizeForSpeech('[天魔神功]을 얻었다.')).toBe('을 얻었다.');
    expect(normalizeForSpeech('비급 〈九陰眞經〉이었다.')).toBe('비급 이었다.');
  });
  test('한글 혼재 괄호는 한자만 제거(내용 보존)', () => {
    expect(normalizeForSpeech('무영(武影, 그림자)은 웃었다.')).toBe('무영(그림자)은 웃었다.');
  });
  test('괄호 밖 본문 한자도 낭독하지 않는다', () => {
    expect(normalizeForSpeech('그는 天下를 꿈꿨다.')).toBe('그는 를 꿈꿨다.');
  });
  test('한글은 절대 삼키지 않는다(U+F900 정규화 사고 회귀 방지)', () => {
    const s = '가나다라마바사 아자차카타파하, 힣까지 전부.';
    expect(normalizeForSpeech(s)).toBe(s);
  });
});

describe('단어 중간 공백 병합(v1.26.1 — 하드랩 잔여 공백의 톤 붕 뜸 방지, tone_probe EXP3)', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  test('다음절 어미 조각(습니다/입니다/니다)은 위치 불문 병합', () => {
    expect(normalizeForSpeech('그 결정이 옳다고 생각합 니다.')).toBe('그 결정이 옳다고 생각합니다.');
    expect(normalizeForSpeech('내일 다시 오겠 습니다.')).toBe('내일 다시 오겠습니다.');
    expect(normalizeForSpeech('그것이 사실 입니다. 그리고 끝났다.')).toBe('그것이 사실입니다. 그리고 끝났다.');
  });
  test('1자 "다"는 문말 + 앞 음절 니/ㅆ받침일 때만 병합(활용형 절단 시그니처)', () => {
    expect(normalizeForSpeech('그 결정이 옳다고 생각합니 다.')).toBe('그 결정이 옳다고 생각합니다.');
    expect(normalizeForSpeech('그는 조용히 말했 다.')).toBe('그는 조용히 말했다.');
    expect(normalizeForSpeech('어제 학교에 갔 다.')).toBe('어제 학교에 갔다.');
  });
  test('정상 구어체·부사·명사 어절은 훼손하지 않는다(교차검증 Gemini 실증 사례)', () => {
    for (const s of [
      '밤을 까.', // 동사 "까다" 반말 명령
      '그냥 다.', // 부사 "다"(전부)
      '이제 거의 다.',
      '얇은 요.', // 명사 "요"(이불)
      '이곳이 우리 집이 요.', // 1자 "요"는 전면 제외(오탐 위험 > 이득)
      '그는 문을 열었다.',
      '할 수 있다.',
      '그런 것 같다.',
      '해야 한다.',
      '바닥에 요를 깔았다.',
    ]) {
      expect(normalizeForSpeech(s)).toBe(s);
    }
  });
  test('문장 중간의 1자 "다"는 병합하지 않는다(문말 위치 한정)', () => {
    const s = '그렇 다 해도 어쩔 수 없었다.';
    expect(normalizeForSpeech(s)).toBe(s);
  });
});

describe('어미 병합 — 닫는 따옴표 경계(codex 교차검증 지적)', () => {
  const { normalizeForSpeech } = require('../tts/sherpa/normalizeKo');
  test('어미 조각 뒤에 닫는 따옴표가 와도 병합', () => {
    expect(normalizeForSpeech('"정말 좋습니 다."')).toBe('"정말 좋습니다."');
    expect(normalizeForSpeech('『그는 결국 떠났 다』.')).toBe('『그는 결국 떠났다』.');
  });
  test('codex 반례(수정 전 정규식 오탐 사례)는 새 규칙에서 보존', () => {
    for (const s of ['먹을 것은 모두 다.', '정답은 다.', '침구는 요.']) {
      expect(normalizeForSpeech(s)).toBe(s);
    }
  });
});

describe('말줄임 표기 통일(v1.27.0) — ASCII 점 연속은 이 팩이 "소리로 읽는다"', () => {
  // 실측 2026-07-21(ell_probe.py): "그는... 조용히 걸었다."가 "그는… 조용히 걸었다."보다
  // +0.47s 길고 그 중 유성음 +0.30s(= 무음 쉼이 아니라 발성). 사용자 보고의 "으데쓰" 정체.
  test('.. ... .... 는 모두 …로 접힌다', () => {
    expect(normalizeForSpeech('그는... 조용히 걸었다.')).toBe('그는… 조용히 걸었다.');
    expect(normalizeForSpeech('그는.. 걸었다')).toBe('그는… 걸었다');
    expect(normalizeForSpeech('그랬다....')).toBe('그랬다…');
  });
  test('유니코드 변형(‥ ⋯)과 연속 …도 하나로', () => {
    expect(normalizeForSpeech('그는‥ 걸었다')).toBe('그는… 걸었다');
    expect(normalizeForSpeech('그는⋯⋯ 걸었다')).toBe('그는… 걸었다');
    expect(normalizeForSpeech('그는…… 걸었다')).toBe('그는… 걸었다');
  });
  test('보통 마침표 1개·소수점·날짜 연쇄는 건드리지 않는다', () => {
    expect(normalizeForSpeech('걸었다.')).toBe('걸었다.');
    expect(normalizeForSpeech('36.5도')).toContain('점');
    expect(normalizeForSpeech('1945. 8. 15.')).toContain('년');
  });
});
