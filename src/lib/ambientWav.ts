// 432Hz 배경 앰비언트 루프 WAV 생성(순수 함수). 낭독 뒤에 은은히 깔리는 드론.
//
// ⚠️ 432Hz "치유 주파수"의 건강 효과는 과학적으로 입증된 바 없다. 다만 부드러운 저음 드론은
// 낭독 청취 시 편안함을 준다고 느끼는 사람이 많아 "켜고 끄는" 선택형 배경음으로 제공한다.
//
// 설계(끊김 없는 루프의 핵심): 8초 루프. 모든 성분 주파수를 0.125Hz(=1/8초)의 정수배로 잡아
// 8초에 정확히 정수 사이클이 완성되게 한다 → 루프 이음매에서 파형이 연속(클릭 없음). 진폭
// LFO(느린 스웰)도 0.125Hz(루프당 1회)라 이음매에서 연속. 저음 옥타브(108·216·432)로 따뜻하게,
// 432 옆에 432.125를 살짝 겹쳐 0.125Hz 비트(루프당 1회 맥놀이)로 은은한 일렁임을 준다.

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
function writeS16LE(buf: Uint8Array, offset: number, v: number): void {
  const c = Math.max(-32768, Math.min(32767, Math.round(v)));
  const u = c < 0 ? c + 0x10000 : c;
  buf[offset] = u & 0xff;
  buf[offset + 1] = (u >>> 8) & 0xff;
}

// 8초 루프. 성분 주파수는 모두 0.125Hz 정수배(432.125 포함) → 심리스.
const LOOP_SECONDS = 8;
// 최고 성분이 432Hz라 낮은 샘플레이트로 충분(파일 크기↓). 22050Hz·16bit·mono ≈ 350KB.
const SAMPLE_RATE = 22050;

// 생성 결과의 정확한 바이트 크기(헤더 44 + 프레임*2). 파일 재사용 판정에 쓴다(매 실행 재생성 방지).
export const AMBIENT_WAV_SIZE = HEADER_SIZE + LOOP_SECONDS * SAMPLE_RATE * 2;

// [주파수Hz, 진폭] — 합 피크 ≈ 0.87, 마스터 게인으로 여유 확보.
// 2026-07-17 사용자 피드백("너무 일렁이지 않게"): 음량은 그대로 두고, 스웰(LFO)과 디튠 맥놀이만
// 크게 줄여 거의 평평하고 잔잔한 드론으로. (같은 날 "크기는 실제로 들으니 괜찮다"고 확인 → 음량 유지.)
const PARTIALS: Array<[number, number]> = [
  [108, 0.42], // 아래 2옥타브 — 따뜻한 저음
  [216, 0.26], // 아래 1옥타브
  [432, 0.14], // 기준음
  [432.125, 0.05], // 아주 살짝만 디튠 → 미세한 0.125Hz 맥놀이(일렁임 최소, 예전 0.14에서 줄임)
];
const MASTER_GAIN = 0.7; // 파일 피크 ≈ 0.61 (v1.20.4와 사실상 같은 음량 — 사용자가 괜찮다 함)
const LFO_HZ = 0.125; // 느린 스웰 — 루프당 1회
const LFO_DEPTH = 0.05; // 0.95 .. 1.00 — 거의 평평하게(예전 0.18에서 크게 줄임 = 일렁임↓)

export function buildAmbientWav(): Uint8Array {
  const frames = LOOP_SECONDS * SAMPLE_RATE; // 정수(8*22050=176400)
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buf = new Uint8Array(HEADER_SIZE + dataSize);

  writeAscii(buf, 0, 'RIFF');
  writeU32LE(buf, 4, 36 + dataSize);
  writeAscii(buf, 8, 'WAVE');
  writeAscii(buf, 12, 'fmt ');
  writeU32LE(buf, 16, 16);
  writeU16LE(buf, 20, 1); // PCM
  writeU16LE(buf, 22, channels);
  writeU32LE(buf, 24, SAMPLE_RATE);
  writeU32LE(buf, 28, SAMPLE_RATE * channels * bytesPerSample);
  writeU16LE(buf, 32, channels * bytesPerSample);
  writeU16LE(buf, 34, bytesPerSample * 8);
  writeAscii(buf, 36, 'data');
  writeU32LE(buf, 40, dataSize);

  const twoPi = Math.PI * 2;
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let k = 0; k < PARTIALS.length; k++) {
      s += PARTIALS[k][1] * Math.sin(twoPi * PARTIALS[k][0] * t);
    }
    // 느린 스웰(0.82..1.0). sin(0)=0 → 이음매(t=0, t=8)에서 배율 0.82로 연속.
    const lfo = 1 - LFO_DEPTH * (0.5 - 0.5 * Math.cos(twoPi * LFO_HZ * t));
    writeS16LE(buf, HEADER_SIZE + i * bytesPerSample, s * lfo * MASTER_GAIN * 32767);
  }
  return buf;
}
