import { compressSilence, findSilenceCuts } from '../tts/sherpa/smartSpeed';

// sr=1000 → 10ms 창 = 10샘플, ms = 샘플 인덱스(계산 검증이 눈으로 가능).
const SR = 1000;

function signal(parts: Array<{ ms: number; amp: number }>): number[] {
  const out: number[] = [];
  for (const p of parts) {
    for (let i = 0; i < p.ms; i++) out.push(p.amp === 0 ? 0 : (i % 2 === 0 ? p.amp : -p.amp));
  }
  return out;
}

describe('smartSpeed 무음 압축(순수 신호처리)', () => {
  test('긴 쉼 없음 — 원본 그대로(factor 1, 시간 매핑 항등)', () => {
    const s = signal([{ ms: 300, amp: 0.5 }, { ms: 150, amp: 0 }, { ms: 300, amp: 0.5 }]);
    const c = compressSilence(s, SR);
    expect(c.factor).toBe(1);
    expect(c.samples).toEqual(s);
    expect(c.mapMs(123)).toBe(123);
  });

  test('내부 쉼 400ms — 양쪽 40ms 남기고 320ms 제거, 말소리 구간은 샘플 단위로 무손상', () => {
    const s = signal([{ ms: 300, amp: 0.5 }, { ms: 400, amp: 0 }, { ms: 300, amp: 0.5 }]);
    const cuts = findSilenceCuts(s, SR);
    expect(cuts).toEqual([{ start: 340, end: 660 }]);
    const c = compressSilence(s, SR);
    expect(c.samples.length).toBe(1000 - 320);
    expect(c.factor).toBeCloseTo(1000 / 680, 5);
    // 앞 말소리(0..339)와 뒤 말소리(660..999)가 그대로 이어붙는다
    expect(c.samples.slice(0, 340)).toEqual(s.slice(0, 340));
    expect(c.samples.slice(340)).toEqual(s.slice(660));
  });

  test('타임스탬프 재매핑 — 쉼 뒤 단어는 제거량만큼 당겨지고, 제거 구간 내부는 절단점으로', () => {
    const s = signal([{ ms: 300, amp: 0.5 }, { ms: 400, amp: 0 }, { ms: 300, amp: 0.5 }]);
    const c = compressSilence(s, SR);
    expect(c.mapMs(100)).toBe(100); // 쉼 앞 — 불변
    expect(c.mapMs(700)).toBe(380); // 두 번째 말소리 시작: 700 − 320
    expect(c.mapMs(500)).toBe(340); // 제거 구간 한복판 → 절단점
    // 단조 증가(하이라이트 폴링이 역행하지 않는다)
    let prev = -1;
    for (let ms = 0; ms <= 1000; ms += 25) {
      const m = c.mapMs(ms);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  test('문장 앞뒤 무음 — 말소리 쪽 40ms만 남기고 정리', () => {
    const s = signal([{ ms: 300, amp: 0 }, { ms: 400, amp: 0.5 }, { ms: 300, amp: 0 }]);
    const cuts = findSilenceCuts(s, SR);
    expect(cuts).toEqual([
      { start: 0, end: 260 }, // 선행: 말소리 직전 40ms 만 남김
      { start: 740, end: 1000 }, // 후행: 말소리 직후 40ms 만 남김
    ]);
    const c = compressSilence(s, SR);
    expect(c.samples.length).toBe(1000 - 260 - 260);
  });

  test('160ms 미만 쉼은 보존(운율 유지), 저레벨 노이즈(문턱 이하)는 무음으로 취급', () => {
    const short = signal([{ ms: 200, amp: 0.5 }, { ms: 150, amp: 0 }, { ms: 200, amp: 0.5 }]);
    expect(findSilenceCuts(short, SR)).toEqual([]);
    const noisy = signal([{ ms: 300, amp: 0.5 }, { ms: 400, amp: 0.005 }, { ms: 300, amp: 0.5 }]);
    expect(findSilenceCuts(noisy, SR)).toEqual([{ start: 340, end: 660 }]);
  });

  test('빈 입력·전체 무음 — 안전(예외 없음, factor 유한)', () => {
    expect(compressSilence([], SR).factor).toBe(1);
    const allQuiet = signal([{ ms: 500, amp: 0 }]);
    const c = compressSilence(allQuiet, SR);
    expect(Number.isFinite(c.factor)).toBe(true);
    expect(c.factor).toBeGreaterThanOrEqual(1);
  });
});
