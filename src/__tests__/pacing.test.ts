import { sentenceGapMs } from '../lib/pacing';
import { segmentDocument } from '../lib/segment';

// 낭독 페이스 자연화 스펙 — 문장 사이 "추가" 쉼(기본 360ms 위에 얹힘)의 문맥 변주.

const P = '바람이 불었다.'; // 평범한 짧은 문장(특징 없음)
const at1 = (prev: string, next: string, para = false) =>
  sentenceGapMs(prev, next, { paragraphBreak: para, rate: 1 });

describe('sentenceGapMs', () => {
  test('결정적 — 같은 입력이면 항상 같은 값', () => {
    expect(at1(P, P)).toBe(at1(P, P));
  });

  test('특징 없는 평문 사이는 미세 변주만(0~50ms)', () => {
    const v = at1(P, '해가 떴다.');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(50);
  });

  test('문단 전환은 유의미하게 길다(+350 기준)', () => {
    const flat = at1(P, '해가 떴다.');
    const para = at1(P, '해가 떴다.', true);
    expect(para - flat).toBe(350);
    expect(para).toBeGreaterThanOrEqual(300);
  });

  test('말줄임 뒤 > 물음표 뒤 > 평문(닫는 인용부호가 붙어도 인식)', () => {
    const ellipsis = at1('그는 말을 잇지 못했다…', P);
    const ellipsisQuoted = at1('"그건 좀…"', P);
    const question = at1('정말 그랬을까?', P);
    expect(ellipsis).toBeGreaterThanOrEqual(200);
    // 인용부호 문장은 대화문 beat 도 함께 받는다(말줄임 + 대화).
    expect(ellipsisQuoted).toBeGreaterThanOrEqual(300);
    expect(question).toBeGreaterThanOrEqual(70);
    expect(ellipsis).toBeGreaterThan(question);
  });

  test('대화문 경계 beat — 닫는 인용부호로 끝나거나 여는 인용부호로 시작', () => {
    expect(at1('"이제 가자."', P)).toBeGreaterThanOrEqual(100);
    expect(at1(P, '"어디로?"')).toBeGreaterThanOrEqual(100);
  });

  test('긴 문장 뒤 숨 회복(50자·80자 임계)', () => {
    const long = '가'.repeat(85) + '.';
    const mid = '나'.repeat(55) + '.';
    expect(at1(long, P)).toBeGreaterThanOrEqual(100);
    expect(at1(long, P)).toBeGreaterThan(at1(mid, P));
  });

  test('배속 비례 축소·>3× 는 0·상한 700+지터50', () => {
    const heavy = '"그건 좀…"';
    const v1 = sentenceGapMs(heavy, '"뭐가?"', { paragraphBreak: true, rate: 1 });
    const v2 = sentenceGapMs(heavy, '"뭐가?"', { paragraphBreak: true, rate: 2 });
    // 극적 조합(문단+말줄임+대화=750)도 상한 700에서 잘리되 지터(±50)는 살아 있다.
    expect(v1).toBeGreaterThanOrEqual(650);
    expect(v1).toBeLessThanOrEqual(750);
    expect(Math.abs(v2 - Math.round(v1 / 2))).toBeLessThanOrEqual(1);
    expect(sentenceGapMs(heavy, '"뭐가?"', { paragraphBreak: true, rate: 3.5 })).toBe(0);
  });

  test('경계 입력 — 빈 문자열·0 이하 배속(방어)도 안전', () => {
    const e = sentenceGapMs('', '', { paragraphBreak: false, rate: 1 });
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThanOrEqual(50);
    const z = sentenceGapMs(P, P, { paragraphBreak: true, rate: 0 });
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThanOrEqual(0);
  });
});

describe('segmentDocument(문단 시작 인덱스)', () => {
  test('빈 줄로 나뉜 문단의 첫 문장 인덱스를 기록한다', () => {
    const raw = '첫 문단이다. 둘째 문장.\n\n둘째 문단이다.\n\n셋째 문단 하나. 셋째 문단 둘.';
    const { sentences, paraStarts } = segmentDocument(raw);
    expect(sentences).toEqual([
      '첫 문단이다.',
      '둘째 문장.',
      '둘째 문단이다.',
      '셋째 문단 하나.',
      '셋째 문단 둘.',
    ]);
    expect(paraStarts).toEqual([0, 2, 3]);
  });

  test('segmentSentences 와 문장 배열이 동일(하위 호환)', () => {
    const raw = '하나. 둘.\n\n셋.';
    const { sentences } = segmentDocument(raw);
    expect(sentences).toEqual(['하나.', '둘.', '셋.']);
  });

  test('단일 개행(하드랩)은 문단이 아니다 — 빈 줄만 문단 경계', () => {
    const raw = '한 문장이 줄에\n걸쳐 접혀 있다.\n\n다음 문단이다.';
    const { sentences, paraStarts } = segmentDocument(raw);
    expect(sentences).toEqual(['한 문장이 줄에', '걸쳐 접혀 있다.', '다음 문단이다.']);
    expect(paraStarts).toEqual([0, 2]);
  });

  test('빈 입력', () => {
    expect(segmentDocument('')).toEqual({ sentences: [], paraStarts: [] });
  });
});
