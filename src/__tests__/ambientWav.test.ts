import { buildAmbientWav, AMBIENT_WAV_SIZE } from '../lib/ambientWav';

// 432Hz 배경 앰비언트 루프의 무결성 — 헤더/크기/심리스 이음매/클리핑 없음.
// 배경음이 낭독 뒤에 깔리므로, 잘못된 WAV(크기 불일치·클릭·클리핑)는 바로 귀에 거슬린다.

function readAscii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}
function readU32(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24);
}
function readU16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}
function readS16(b: Uint8Array, off: number): number {
  const u = readU16(b, off);
  return u >= 0x8000 ? u - 0x10000 : u;
}

const wav = buildAmbientWav();

test('올바른 WAV 헤더(RIFF/WAVE/PCM mono 16bit 22050)', () => {
  expect(readAscii(wav, 0, 4)).toBe('RIFF');
  expect(readAscii(wav, 8, 4)).toBe('WAVE');
  expect(readAscii(wav, 12, 4)).toBe('fmt ');
  expect(readU16(wav, 20)).toBe(1); // PCM
  expect(readU16(wav, 22)).toBe(1); // mono
  expect(readU32(wav, 24)).toBe(22050); // sampleRate
  expect(readU16(wav, 34)).toBe(16); // bits
  expect(readAscii(wav, 36, 4)).toBe('data');
});

test('크기가 AMBIENT_WAV_SIZE 상수와 정확히 일치(파일 재사용 판정 근거)', () => {
  expect(wav.length).toBe(AMBIENT_WAV_SIZE);
  expect(readU32(wav, 40)).toBe(wav.length - 44); // data 청크 크기 = 프레임 바이트
});

test('루프 이음매가 매끄럽다: 첫 샘플이 0(모든 성분 sin 이 t=0에서 0)', () => {
  expect(readS16(wav, 44)).toBe(0);
});

test('클리핑 없음: 모든 샘플이 16bit 범위 안이고 피크가 상한 미만', () => {
  let peak = 0;
  for (let off = 44; off + 1 < wav.length; off += 2) {
    const v = readS16(wav, off);
    expect(v).toBeGreaterThanOrEqual(-32768);
    expect(v).toBeLessThanOrEqual(32767);
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // 설계 피크 ≈ 0.67*32767 ≈ 22000. 여유를 두고 상한만 확인(클리핑 방지).
  expect(peak).toBeLessThan(30000);
  expect(peak).toBeGreaterThan(5000); // 무음이 아님(실제 소리가 있음)
});
