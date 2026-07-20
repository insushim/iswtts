import { buildSilenceWav } from '../lib/silenceWav';

function ascii(buf: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...buf.slice(off, off + len));
}
function u32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

describe('buildSilenceWav (앵커용 무음 WAV)', () => {
  it('유효한 RIFF/WAVE PCM 헤더', () => {
    const wav = buildSilenceWav(2, 8000);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(1); // mono
    expect(u32(wav, 24)).toBe(8000); // sampleRate
    expect(u16(wav, 34)).toBe(16); // bitsPerSample
  });

  it('크기 필드가 실제 길이와 일치', () => {
    const wav = buildSilenceWav(2, 8000);
    const dataSize = 2 * 8000 * 2; // 2초 × 8kHz × 16bit
    expect(u32(wav, 40)).toBe(dataSize);
    expect(u32(wav, 4)).toBe(36 + dataSize);
    expect(wav.length).toBe(44 + dataSize);
  });

  it('데이터부는 전부 0(무음)', () => {
    const wav = buildSilenceWav(0.01, 8000);
    expect(wav.slice(44).every((b) => b === 0)).toBe(true);
  });

  it('0초 이하도 최소 1프레임 생성(빈 파일 방지)', () => {
    const wav = buildSilenceWav(0, 8000);
    expect(u32(wav, 40)).toBe(2);
  });
});

describe('buildPcmWav (float 샘플 → 16-bit WAV — 문단 들숨용 일반형)', () => {
  const { buildPcmWav } = require('../lib/silenceWav');

  it('유효 헤더 + 크기 필드 일치(임의 샘플레이트)', () => {
    const samples = [0, 0.5, -0.5, 1, -1];
    const wav = buildPcmWav(samples, 22050);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(u32(wav, 24)).toBe(22050);
    expect(u32(wav, 40)).toBe(samples.length * 2);
    expect(wav.length).toBe(44 + samples.length * 2);
  });

  it('샘플 값이 16-bit 로 정확히 부호화되고 ±1 초과는 클램프', () => {
    const wav = buildPcmWav([0.5, -0.5, 2, -2], 8000);
    const s16 = (off: number) => {
      const v = wav[44 + off * 2] | (wav[44 + off * 2 + 1] << 8);
      return v >= 0x8000 ? v - 0x10000 : v;
    };
    expect(s16(0)).toBe(Math.round(0.5 * 32767));
    expect(s16(1)).toBe(Math.round(-0.5 * 32767)); // Math.round 는 -.5 를 위로 올림(-16383)
    expect(s16(2)).toBe(32767);
    expect(s16(3)).toBe(-32767);
  });
});
