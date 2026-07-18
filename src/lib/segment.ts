// 한국어 친화 문장 분할. TTS 재생/자막 표시의 기본 단위(문장)를 만든다.
// expo-speech의 입력 상한(대략 수천 자)과 자막 가독성을 위해 긴 문장은 더 쪼갠다.

const MAX_LEN = 280; // 한 자막(문장) 최대 길이. 너무 길면 화면/발화 단위로 부적절.

function hardWrap(s: string): string[] {
  if (s.length <= MAX_LEN) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_LEN) {
    // 쉼표/공백 등 자연 경계에서 자른다.
    let cut = -1;
    for (const sep of ['. ', ', ', '; ', ' ', '，', '、']) {
      const idx = rest.lastIndexOf(sep, MAX_LEN);
      if (idx > MAX_LEN * 0.5) { cut = idx + sep.length; break; }
    }
    if (cut < 0) cut = MAX_LEN;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export type SegmentedDoc = {
  sentences: string[];
  /** 문단을 새로 시작하는 문장 인덱스들(0 = 첫 문단). 낭독 페이스(pacing.ts)가 문단 전환
   *  호흡에 쓴다. 원문 텍스트는 저장하지 않으므로 여기서 계산해 문서와 함께 보존해야 한다. */
  paraStarts: number[];
};

export function segmentDocument(raw: string): SegmentedDoc {
  if (!raw) return { sentences: [], paraStarts: [] };
  // 개행/공백 정규화 (단, 문단 경계는 살린다)
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n');

  // 문단 = 빈 줄(\n\n) 경계만. 단일 개행은 하드랩(80자 접기 등)일 수 있어 문단으로 치지
  // 않는다 — 매 줄이 문단이 되면 낭독 페이스의 문단 호흡(+350ms)이 줄마다 붙는 역효과.
  // (문장 분할 자체는 종전대로 줄 단위 — 줄을 넘나드는 문장 결합은 하지 않는다.)
  const blocks = text.split(/\n\n/);
  const sentences: string[] = [];
  const paraStarts: number[] = [];

  // 문장 종결부호(라틴/한중일) + 뒤따르는 닫는 인용부호를 포함해 분할
  const splitter = /(?<=[.!?。！？…]["'”’)\]]?)\s+/;

  for (const block of blocks) {
    let blockStarted = false;
    for (const line of block.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      if (!blockStarted) {
        paraStarts.push(sentences.length);
        blockStarted = true;
      }
      const parts = p.split(splitter);
      for (const part of parts) {
        const s = part.trim();
        if (!s) continue;
        for (const chunk of hardWrap(s)) {
          if (chunk) sentences.push(chunk);
        }
      }
    }
  }
  return { sentences, paraStarts };
}

export function segmentSentences(raw: string): string[] {
  return segmentDocument(raw).sentences;
}
