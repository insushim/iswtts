import { segmentSentences } from '../lib/segment';

describe('segmentSentences (한국어 문장 분할)', () => {
  it('기본 분할: 종결부호+공백 기준', () => {
    const out = segmentSentences('첫 문장입니다. 두 번째 문장입니다! 세 번째인가요? 네.');
    expect(out).toEqual(['첫 문장입니다.', '두 번째 문장입니다!', '세 번째인가요?', '네.']);
  });

  it('닫는 인용부호를 문장에 포함해 분할', () => {
    const out = segmentSentences('"안녕하세요." 그가 말했다.');
    expect(out).toEqual(['"안녕하세요."', '그가 말했다.']);
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
