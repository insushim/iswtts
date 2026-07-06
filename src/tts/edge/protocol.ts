// Edge(Read Aloud) 온라인 신경망 TTS의 와이어 프로토콜 상수·헬퍼.
// 정본: rany2/edge-tts (constants.py / drm.py / communicate.py) 를 그대로 이식.
// 비공식 엔드포인트라 MS가 토큰/버전을 바꾸면 여기 상수만 갱신하면 된다.
import * as Crypto from 'expo-crypto';

// 비밀 아님: Edge Read Aloud 의 공개 고정 상수(모든 edge-tts 구현이 동일값 사용, 문서 공개).
// 계정 접근 권한 없음·로테이션 불가. 시크릿 스캐너 오탐 방지 표기.
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'; // gitleaks:allow
export const CHROMIUM_FULL_VERSION = '143.0.3650.75';
export const CHROMIUM_MAJOR_VERSION = '143';
export const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const TICKS_PER_MS = 10000; // 100ns 틱 → ms

export const WSS_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

// RN WebSocket(네이티브 OkHttp/NSURLSession)은 브라우저와 달리 커스텀 헤더 설정이 된다.
export const WSS_HEADERS: Record<string, string> = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': UA,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

const WIN_EPOCH = 11644473600n;

// Sec-MS-GEC: (유닉스초 + 1601에폭) 을 5분 단위로 내림 → 100ns 틱으로 환산 → +토큰 SHA256 대문자.
// ticks 는 ~1.3e17 로 2^53 를 넘겨 Number 로는 정밀도 손실 → BigInt 필수.
export async function generateSecMsGec(): Promise<string> {
  const unixSec = BigInt(Math.floor(Date.now() / 1000));
  let ticks = unixSec + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n; // 1e9 / 100
  const strToHash = `${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`;
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    strToHash,
  );
  return hex.toUpperCase();
}

export function connectId(): string {
  return Crypto.randomUUID().replace(/-/g, '');
}

export function muidCookie(): string {
  const bytes = Crypto.getRandomBytes(16);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `muid=${hex.toUpperCase()};`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

// JS Date 스타일: "Wed Jul 04 2026 12:00:00 GMT+0000 (Coordinated Universal Time)"
export function dateToString(): string {
  const d = new Date();
  return (
    `${DAYS[d.getUTCDay()]} ${MONS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ` +
    'GMT+0000 (Coordinated Universal Time)'
  );
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 서버가 WordBoundary text 를 XML escape 해서 줄 수 있어, 원문 매칭 전 되돌린다.
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 서비스가 거부하는 제어문자(수직탭 등, OCR PDF에 흔함)를 공백으로 치환.
export function removeIncompatible(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0 && c <= 8) || c === 11 || c === 12 || (c >= 14 && c <= 31)) out += ' ';
    else out += s[i];
  }
  return out;
}

// pitch 는 기본 +0Hz(원음 품질 최선) — 가상 어린이/청소년 음성만 변조값을 넘긴다(voices.ts).
// xml:lang 은 선택 음성 언어를 따른다(비한국어 음성에서 ko-KR 고정 시 거부 방지).
export function buildSsml(
  text: string,
  voice: string,
  language: string,
  ratePct: string,
  pitch: string = '+0Hz',
): string {
  const escaped = escapeXml(removeIncompatible(text));
  const lang = escapeXml(language || 'ko-KR');
  const safeVoice = escapeXml(voice);
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${safeVoice}'>` +
    `<prosody pitch='${escapeXml(pitch)}' rate='${ratePct}' volume='+0%'>` +
    escaped +
    '</prosody></voice></speak>'
  );
}

export function speechConfigMessage(): string {
  return (
    `X-Timestamp:${dateToString()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
    '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
    `"outputFormat":"${OUTPUT_FORMAT}"}}}}`
  );
}

export function ssmlMessage(requestId: string, ssml: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    // X-Timestamp 뒤 Z 는 오타가 아니라 Microsoft Edge 버그 재현(정본 주석 그대로).
    `X-Timestamp:${dateToString()}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  );
}

// Uint8Array → Base64 (RN 에 Buffer 없음). expo-file-system legacy 로 파일 기록용.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64[b2 & 63] : '=';
  }
  return out;
}
