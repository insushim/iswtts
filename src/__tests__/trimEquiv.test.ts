import { trimEdgeSilence, edgeSilenceCuts } from '../tts/sherpa/smartSpeed';

// 구(舊) 구현 — 컷 기반 요소별 복사(리팩터 전 코드 그대로)
function oldTrim(samples: ArrayLike<number>, sampleRate: number): number[] {
  const cuts = edgeSilenceCuts(samples, sampleRate);
  if (!cuts.length) return Array.from(samples);
  const n = samples.length;
  let removed = 0;
  for (const c of cuts) removed += c.end - c.start;
  if (removed >= n) return Array.from(samples);
  const out = new Array<number>(n - removed);
  let w = 0;
  let pos = 0;
  for (const c of cuts) {
    for (let i = pos; i < c.start; i++) out[w++] = samples[i];
    pos = c.end;
  }
  for (let i = pos; i < n; i++) out[w++] = samples[i];
  return out;
}

function rnd(seed: number) { let x = seed; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

test('slice 리팩터는 구 구현과 샘플 단위로 동일(무작위 200 케이스)', () => {
  const r = rnd(7);
  for (let k = 0; k < 200; k++) {
    const sr = 44100;
    const n = 2000 + Math.floor(r() * 40000);
    const lead = Math.floor(r() * 30000);
    const trail = Math.floor(r() * 30000);
    const x = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const silent = i < lead || i >= n - trail;
      x[i] = silent ? (r() - 0.5) * 0.002 : (r() - 0.5) * (0.1 + r());
    }
    expect(trimEdgeSilence(x, sr)).toEqual(oldTrim(x, sr));
  }
});

test('전체 무음도 원본 유지(빈 오디오 금지)', () => {
  const x = new Array(20000).fill(0.0001);
  expect(trimEdgeSilence(x, 44100).length).toBe(20000);
});
