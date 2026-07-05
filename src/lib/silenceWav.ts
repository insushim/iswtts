// 무음 WAV 생성(순수 함수). 잠금화면 세션 앵커 플레이어가 루프 재생할 파일을 런타임에 만든다.
// (바이너리 에셋을 저장소에 넣지 않기 위해 코드로 생성 — 16-bit PCM mono)

const HEADER_SIZE = 44;

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}

function writeU32LE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
  buf[offset + 2] = (v >>> 16) & 0xff;
  buf[offset + 3] = (v >>> 24) & 0xff;
}

function writeU16LE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
}

export function buildSilenceWav(seconds: number, sampleRate = 8000): Uint8Array {
  const channels = 1;
  const bytesPerSample = 2; // 16-bit
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = frames * channels * bytesPerSample;
  const buf = new Uint8Array(HEADER_SIZE + dataSize); // 데이터부는 0(무음) 그대로

  writeAscii(buf, 0, 'RIFF');
  writeU32LE(buf, 4, 36 + dataSize);
  writeAscii(buf, 8, 'WAVE');
  writeAscii(buf, 12, 'fmt ');
  writeU32LE(buf, 16, 16); // fmt 청크 크기
  writeU16LE(buf, 20, 1); // PCM
  writeU16LE(buf, 22, channels);
  writeU32LE(buf, 24, sampleRate);
  writeU32LE(buf, 28, sampleRate * channels * bytesPerSample); // byteRate
  writeU16LE(buf, 32, channels * bytesPerSample); // blockAlign
  writeU16LE(buf, 34, bytesPerSample * 8); // bitsPerSample
  writeAscii(buf, 36, 'data');
  writeU32LE(buf, 40, dataSize);
  return buf;
}
