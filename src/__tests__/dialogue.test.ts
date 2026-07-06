import { splitDialogue, hasDialogue } from '../lib/dialogue';

// 핵심 불변식: 문장 내 세그먼트 text 를 이어붙이면 원문과 정확히 일치 + start 오프셋 정합.
function checkReconstruction(sentences: string[]) {
  const all = splitDialogue(sentences);
  expect(all.length).toBe(sentences.length);
  all.forEach((segs, i) => {
    expect(segs.map((s) => s.text).join('')).toBe(sentences[i]);
    let pos = 0;
    for (const seg of segs) {
      expect(seg.start).toBe(pos);
      pos += seg.text.length;
    }
  });
  return all;
}

describe('splitDialogue — 따옴표 대사 분할', () => {
  test('따옴표 없음 — 문장 전체가 지문 1세그먼트', () => {
    const [segs] = checkReconstruction(['옛날 옛적 어느 마을에 나무꾼이 살았습니다.']);
    expect(segs).toHaveLength(1);
    expect(segs[0].dialogue).toBe(false);
  });

  test('한 문장 안의 대사 — 지문/대사/지문, 따옴표는 대사에 포함', () => {
    const [segs] = checkReconstruction(['그가 “안녕하세요 저는 소리책입니다” 하고 인사했다.']);
    expect(segs.map((s) => s.dialogue)).toEqual([false, true, false]);
    expect(segs[1].text).toBe('“안녕하세요 저는 소리책입니다”');
    expect(segs[1].start).toBe('그가 '.length);
  });

  test('문장 경계를 넘는 대사 — 중간 문장(따옴표 없음)도 대사로 분류', () => {
    const all = checkReconstruction([
      '그가 말했다. “안녕하세요.',
      '저는 소리책입니다.',
      '반갑습니다.” 그리고 떠났다.',
    ]);
    expect(all[0].map((s) => s.dialogue)).toEqual([false, true]);
    expect(all[1].map((s) => s.dialogue)).toEqual([true]); // 통째로 대사
    expect(all[2].map((s) => s.dialogue)).toEqual([true, false]);
  });

  test('짝 잃은 따옴표 — 닫는 짝이 스팬(600자) 안에 없으면 평문 취급(폭주 방지)', () => {
    const long = '가'.repeat(700);
    const all = checkReconstruction([`그가 “인사했다.`, long, '끝났다.']);
    expect(hasDialogue(all)).toBe(false);
  });

  test('ASCII 따옴표·낫표 짝 지원, 종류가 다른 닫는 짝은 무시', () => {
    const all = checkReconstruction(['그는 "hello" 라고 썼고 「소리책」이라 불렀다.']);
    expect(all[0].filter((s) => s.dialogue).map((s) => s.text)).toEqual(['"hello"', '「소리책」']);
    // 여는 “ 에 대해 」 는 짝이 아님
    const [odd] = checkReconstruction(['그가 “인사했다」 라고.']);
    expect(odd.every((s) => !s.dialogue)).toBe(true);
  });

  test('구두점뿐인 지문은 이웃에 흡수 — 퇴화 발화 세그먼트 없음', () => {
    const [segs] = checkReconstruction(['“네.” “알겠습니다.” 그가 답했다.']);
    for (const s of segs) expect(/[\p{L}\p{N}]/u.test(s.text)).toBe(true);
    // 두 대사 사이 공백(" ")이 앞 대사에 흡수돼도 재구성은 정확(위 checkReconstruction)
    expect(segs.filter((s) => s.dialogue).length).toBeGreaterThanOrEqual(2);
  });

  test('ASCII 따옴표 과대 스팬 — 짝 후보까지 함께 버려 이후 짝이 밀리지 않는다(연쇄 오분류 방지)', () => {
    // 첫 " 의 짝(끝. 뒤)이 600자 밖 → 둘 다 평문. 뒤의 "좋아" 는 온전히 대사로 남아야 한다.
    const all = checkReconstruction(['그가 "말했다.', '가'.repeat(700) + '끝." 그리고 "좋아" 했다.']);
    const dlg = all.flat().filter((s) => s.dialogue).map((s) => s.text);
    expect(dlg).toEqual(['"좋아"']);
  });

  test('문장당 세그먼트 상한 — 병리적 따옴표 반복은 지문 통째 폴백(발화 증폭 방지)', () => {
    const crazy = Array.from({ length: 20 }, (_, k) => `“대${k}” 지${k}`).join(' ');
    const [segs] = checkReconstruction([crazy]);
    expect(segs).toEqual([{ text: crazy, start: 0, dialogue: false }]);
    // 정상 밀도(대사 3개)는 그대로 분할
    const [ok] = checkReconstruction(['“하나” 하고 “둘” 하고 “셋” 했다.']);
    expect(ok.filter((s) => s.dialogue)).toHaveLength(3);
  });

  test('병리 텍스트 성능 카나리아 — 짝 없는 여는 따옴표 3만 개도 즉시 처리(O(n²) 재발 방지)', () => {
    const t0 = Date.now();
    const all = splitDialogue(['“'.repeat(30000) + ' 끝.']);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(hasDialogue(all)).toBe(false);
  });

  test('연속 대사·문장 첫머리 대사·빈 배열 안전', () => {
    checkReconstruction(['“출발하자” “좋아” 둘은 떠났다.']);
    const [head] = checkReconstruction(['“출발하자” 그가 말했다.']);
    expect(head[0].dialogue).toBe(true);
    expect(head[0].start).toBe(0);
    expect(splitDialogue([])).toEqual([]);
  });
});
