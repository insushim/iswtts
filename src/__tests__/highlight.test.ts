import { splitHighlight } from '../lib/highlight';

describe('splitHighlight', () => {
  it('단어 구간을 3분할', () => {
    expect(splitHighlight('안녕하세요 세상', 6, 2)).toEqual({
      before: '안녕하세요 ',
      word: '세상'.slice(0, 2),
      after: '',
    });
  });
  it('wordLen 0이면 전체가 before', () => {
    expect(splitHighlight('문장', 0, 0)).toEqual({ before: '문장', word: '', after: '' });
  });
  it('경계 밖 인덱스도 안전(빈 문자열)', () => {
    const r = splitHighlight('abc', 10, 5);
    expect(r.before + r.word + r.after).toBe('abc');
  });
});
