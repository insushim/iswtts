import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import iconv from 'iconv-lite';
import { stripTagBlocks } from '../lib/html';

// TXT / MD / HTML 텍스트 추출.
// 인코딩 자동 판별: BOM(UTF-8/16) → UTF-8 유효성 → CP949(EUC-KR).
// 한국 구형 소설 txt 다수가 CP949라 UTF-8 고정 디코딩은 전량 모지바케가 된다.
export async function extractTxt(uri: string): Promise<string> {
  const b64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  const buf = Buffer.from(b64, 'base64');
  return stripIfHtml(decodeSmart(buf));
}

function decodeSmart(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.slice(2), 'utf16le'); // Windows 메모장 "유니코드"
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.slice(2), 'utf16be');
  }
  const utf8 = buf.toString('utf8');
  // 유효한 UTF-8이면 대체문자(U+FFFD)가 생기지 않는다. 생겼다 = UTF-8 아님 → CP949로 재해석.
  if (!utf8.includes('�')) return utf8;
  try {
    return iconv.decode(buf, 'cp949');
  } catch {
    return utf8; // 최후 폴백(일부 깨짐이라도 반환)
  }
}

function stripIfHtml(s: string): string {
  if (!/<\/?[a-z][\s\S]*>/i.test(s)) return s;
  let t = stripTagBlocks(s, 'script');
  t = stripTagBlocks(t, 'style');
  return t
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
