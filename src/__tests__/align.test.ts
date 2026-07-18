import { estimateWordBoundaries } from '../tts/sherpa/align';
import { edgeSilenceCuts, trimEdgeSilence } from '../tts/sherpa/smartSpeed';

const SR = 1000; // 10ms 창 = 10샘플, ms = 샘플 인덱스

function signal(parts: Array<{ ms: number; amp: number }>): number[] {
  const out: number[] = [];
  for (const p of parts) {
    for (let i = 0; i < p.ms; i++) out.push(p.amp === 0 ? 0 : (i % 2 === 0 ? p.amp : -p.amp));
  }
  return out;
}

describe('edgeSilenceCuts / trimEdgeSilence — 앞뒤 무음만 제거(내부 쉼 불변)', () => {
  test('앞 400ms·뒤 500ms 무음 — 패드(앞40·뒤320)만 남기고 제거, 내부 쉼은 그대로', () => {
    // 뒤 패드 320ms = 1× 문장 간 숨(2026-07-18, 구 120 — smartSpeed.ts TRAIL_PAD_MS 근거 참조).
    const s = signal([
      { ms: 400, amp: 0 },
      { ms: 300, amp: 0.5 },
      { ms: 300, amp: 0 }, // 내부 쉼 — 건드리지 않는다
      { ms: 300, amp: 0.5 },
      { ms: 500, amp: 0 },
    ]);
    expect(edgeSilenceCuts(s, SR)).toEqual([
      { start: 0, end: 360 }, // 앞: 40ms 패드만 남김
      { start: 1620, end: 1800 }, // 뒤: 320ms 패드만 남김
    ]);
    const out = trimEdgeSilence(s, SR);
    expect(out.length).toBe(1800 - 360 - 180);
    // 말소리+내부 쉼 구간은 샘플 단위 무손상
    expect(out).toEqual(s.slice(360, 1620));
    // 청크 조립용 커스텀 패드(짧은 쉼표 숨): 명시 인자가 기본값을 대체한다.
    expect(edgeSilenceCuts(s, SR, 40, 80)).toEqual([
      { start: 0, end: 360 },
      { start: 1380, end: 1800 },
    ]);
  });

  test('짧은 앞뒤 무음(<80ms+패드)·무음 없음·전체 무음 — 원본 유지(안전)', () => {
    const short = signal([{ ms: 100, amp: 0 }, { ms: 300, amp: 0.5 }, { ms: 100, amp: 0 }]);
    expect(edgeSilenceCuts(short, SR)).toEqual([]);
    const none = signal([{ ms: 300, amp: 0.5 }]);
    expect(trimEdgeSilence(none, SR)).toEqual(none);
    const all = signal([{ ms: 500, amp: 0 }]);
    expect(trimEdgeSilence(all, SR)).toEqual(all);
  });
});

describe('estimateWordBoundaries — 발화 구간 위 글자수 비례 분배', () => {
  test('쉼 뒤 단어는 발화 재개 지점에 정렬(쉼을 발화 시간으로 세지 않음)', () => {
    // 발화 600ms + 쉼 400ms + 발화 600ms, 두 단어(같은 글자 수)
    const s = signal([{ ms: 600, amp: 0.5 }, { ms: 400, amp: 0 }, { ms: 600, amp: 0.5 }]);
    const b = estimateWordBoundaries('안녕하세요 반갑습니다', s, SR);
    expect(b).toHaveLength(2);
    expect(b[0].ms).toBe(0);
    // 단어2 = 발화축 600ms 지점 = 실제 1000ms(쉼 400ms 건너뜀)
    expect(b[1].ms).toBeCloseTo(1000, 0);
    expect(b[1].charIndex).toBe(6);
    expect(b[1].charLen).toBe(5);
  });

  test('연속 발화 — 글자수 비례 분배·단조 증가', () => {
    const s = signal([{ ms: 900, amp: 0.5 }]);
    const b = estimateWordBoundaries('하나 둘 셋', s, SR);
    expect(b.map((x) => x.charIndex)).toEqual([0, 3, 5]);
    // 가중치 2:1:1 → 시작점 0, 450, 675
    expect(b[0].ms).toBe(0);
    expect(b[1].ms).toBeCloseTo(450, 0);
    expect(b[2].ms).toBeCloseTo(675, 0);
    for (let i = 1; i < b.length; i++) expect(b[i].ms).toBeGreaterThan(b[i - 1].ms);
  });

  test('공백 없는 긴 문자열 — 4자 조각으로 분할돼 하이라이트가 전진(회귀 방지)', () => {
    const s = signal([{ ms: 1000, amp: 0.5 }]);
    const b = estimateWordBoundaries('가나다라마바사아자차카타', s, SR); // 12자, 공백 없음
    expect(b).toHaveLength(3); // 4자 × 3조각
    expect(b.map((x) => x.charIndex)).toEqual([0, 4, 8]);
    expect(b.map((x) => x.charLen)).toEqual([4, 4, 4]);
    for (let i = 1; i < b.length; i++) expect(b[i].ms).toBeGreaterThan(b[i - 1].ms);
  });

  test('빈 텍스트·빈 오디오·전체 무음 — 안전', () => {
    expect(estimateWordBoundaries('', signal([{ ms: 100, amp: 0.5 }]), SR)).toEqual([]);
    expect(estimateWordBoundaries('안녕', [], SR)).toEqual([]);
    const b = estimateWordBoundaries('안녕 하세요', signal([{ ms: 400, amp: 0 }]), SR);
    expect(b).toHaveLength(2); // 전체 무음 폴백 — 균등 분배라도 반환
  });
});
