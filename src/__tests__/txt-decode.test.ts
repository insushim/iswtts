import { Buffer } from 'buffer';
import iconv from 'iconv-lite';
import { decodeSmart } from '../extract/txt';

const SAMPLE = '옛날 옛적에 호랑이가 살았습니다. 소리책 테스트 1998년.';

describe('decodeSmart (TXT 인코딩 자동 판별)', () => {
  it('UTF-8', () => {
    expect(decodeSmart(Buffer.from(SAMPLE, 'utf8'))).toBe(SAMPLE);
  });
  it('UTF-8 + BOM (BOM 제거)', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, 'utf8')]);
    expect(decodeSmart(buf)).toBe(SAMPLE);
  });
  it('CP949 (한국 구형 txt)', () => {
    expect(decodeSmart(iconv.encode(SAMPLE, 'cp949'))).toBe(SAMPLE);
  });
  it('UTF-16LE + BOM (Windows 메모장 유니코드)', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(SAMPLE, 'utf16le')]);
    expect(decodeSmart(buf)).toBe(SAMPLE);
  });
  it('순수 ASCII는 그대로', () => {
    expect(decodeSmart(Buffer.from('hello world', 'utf8'))).toBe('hello world');
  });
});
