// 대사(따옴표 발화) 감지 — "대사는 다른 목소리로" 기능의 순수 분할 로직(테스트 대상).
//
// 설계:
// - 문장 배열 전체를 한 번에 스캔한다. 문장 분할(segment.ts)이 긴 대사를 여러 문장으로
//   쪼갤 수 있어(따옴표가 문장 경계를 넘음), 문장 단위 검사로는 중간 문장을 놓친다.
// - 여는 따옴표는 같은 종류의 닫는 짝이 MAX_QUOTE_SPAN 안에 있을 때만 대사로 인정 —
//   짝 잃은 따옴표 하나가 책 나머지 전체를 대사로 만드는 폭주를 막는다(그 경우 평문 취급).
// - 세그먼트 text 는 원문의 정확한 부분문자열(따옴표 포함): 이어붙이면 원문과 일치하고,
//   start 오프셋으로 단어 하이라이트가 그대로 이어진다.
// - 낱자 없는 세그먼트(구두점·공백뿐)는 이웃에 흡수 — 엔진에 "," 단독 발화 같은
//   퇴화 호출을 만들지 않는다.

export type DialogueSegment = {
  text: string; // 문장의 원문 부분(따옴표 포함) — 문장 내 세그먼트를 이어붙이면 원문
  start: number; // 문장 내 시작 오프셋(단어 하이라이트 보정용)
  dialogue: boolean;
};

// 지원 짝: 큰따옴표 계열(한국어 출판 대사 표기). 홑따옴표(생각)·겹낫표(제목)는 제외.
const PAIRS: Record<string, string> = { '“': '”', '「': '」', '"': '"' };
const MAX_QUOTE_SPAN = 600; // 이보다 긴 "대사"는 짝 잃은 따옴표로 간주(평문)
// 문장당 세그먼트 상한 — 병리적 따옴표 반복이 발화 1회를 수십 회의 합성 호출로 증폭시키는
// 것을 막는다(정상 산문은 문장 280자 제한 안에서 2~5개). 초과 시 그 문장은 지문 통째.
const MAX_SEGMENTS_PER_SENTENCE = 12;

const HAS_WORD = /[\p{L}\p{N}]/u;

// 낱자 없는 세그먼트를 이웃에 흡수(재구성 불변식 유지: text 연결 = 원문).
function mergeDegenerate(segs: DialogueSegment[]): DialogueSegment[] {
  const out: DialogueSegment[] = [];
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (prev && !HAS_WORD.test(seg.text)) {
      out[out.length - 1] = { ...prev, text: prev.text + seg.text };
    } else if (prev && !HAS_WORD.test(prev.text)) {
      // 문장 서두의 구두점 잔여 — 첫 실질 세그먼트에 앞붙임(kind 는 실질 쪽)
      out[out.length - 1] = { text: prev.text + seg.text, start: prev.start, dialogue: seg.dialogue };
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

export function splitDialogue(sentences: string[]): DialogueSegment[][] {
  const SEP = '\n';
  const joined = sentences.join(SEP);

  // 1) 전역 대사 범위 [s, e) 수집 — 같은 종류의 닫는 짝까지, 스팬 제한 내에서만.
  // 닫는 짝 탐색은 결과를 메모해 상환 O(n): 짝 없는 여는 따옴표가 대량인 병리 텍스트에서
  // opener 마다 문서 끝까지 재탐색하는 O(n²)을 막는다(탐색 위치는 단조 증가라 재사용 안전).
  const nextCloser: Record<string, number> = {};
  const findCloser = (closer: string, from: number): number => {
    const m = nextCloser[closer];
    if (m !== undefined && (m === -1 || m >= from)) return m;
    return (nextCloser[closer] = joined.indexOf(closer, from));
  };
  const ranges: Array<{ s: number; e: number }> = [];
  let i = 0;
  while (i < joined.length) {
    const closer = PAIRS[joined[i]];
    if (!closer) {
      i++;
      continue;
    }
    const close = findCloser(closer, i + 1);
    if (close < 0) {
      i++; // 짝 없음 — 여는 따옴표를 평문으로 취급
      continue;
    }
    if (close - i > MAX_QUOTE_SPAN) {
      // 과대 스팬 — 평문 취급. 대칭 문자(ASCII ")는 여는/닫는 구분이 없어 짝 후보까지 함께
      // 버려 홀짝을 보존한다(하나만 버리면 이후 모든 짝이 한 칸씩 밀리는 연쇄 오분류).
      i = joined[i] === closer ? close + 1 : i + 1;
      continue;
    }
    ranges.push({ s: i, e: close + 1 });
    i = close + 1;
  }

  // 2) 범위를 문장별로 잘라 세그먼트 생성(문장 경계를 넘는 대사는 양쪽 문장에 분배).
  const out: DialogueSegment[][] = [];
  let off = 0;
  let ri = 0;
  for (const sentence of sentences) {
    const sStart = off;
    const sEnd = off + sentence.length;
    const segs: DialogueSegment[] = [];
    let pos = sStart;
    while (ri < ranges.length && ranges[ri].e <= sStart) ri++;
    let rj = ri;
    while (rj < ranges.length && ranges[rj].s < sEnd) {
      const ds = Math.max(ranges[rj].s, sStart);
      const de = Math.min(ranges[rj].e, sEnd);
      if (ds > pos) segs.push({ text: joined.slice(pos, ds), start: pos - sStart, dialogue: false });
      if (de > ds) segs.push({ text: joined.slice(ds, de), start: ds - sStart, dialogue: true });
      pos = de;
      if (ranges[rj].e <= sEnd) rj++;
      else break; // 이 범위는 다음 문장으로 이어짐 — 소비하지 않고 유지
    }
    if (pos < sEnd) segs.push({ text: joined.slice(pos, sEnd), start: pos - sStart, dialogue: false });
    const merged = mergeDegenerate(segs.length ? segs : [{ text: sentence, start: 0, dialogue: false }]);
    out.push(
      merged.length > MAX_SEGMENTS_PER_SENTENCE
        ? [{ text: sentence, start: 0, dialogue: false }] // 병리적 반복 — 발화 증폭 방지
        : merged,
    );
    ri = rj;
    off = sEnd + SEP.length;
  }
  return out;
}

// 문서에 대사가 하나라도 있는지(설정 안내 등 가벼운 용도).
export function hasDialogue(segs: DialogueSegment[][]): boolean {
  return segs.some((s) => s.some((seg) => seg.dialogue));
}
