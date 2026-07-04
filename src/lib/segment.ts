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

export function segmentSentences(raw: string): string[] {
  if (!raw) return [];
  // 개행/공백 정규화 (단, 문단 경계는 살린다)
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n');

  const paragraphs = text.split(/\n/);
  const sentences: string[] = [];

  // 문장 종결부호(라틴/한중일) + 뒤따르는 닫는 인용부호를 포함해 분할
  const splitter = /(?<=[.!?。！？…]["'”’)\]]?)\s+/;

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    const parts = p.split(splitter);
    for (const part of parts) {
      const s = part.trim();
      if (!s) continue;
      for (const chunk of hardWrap(s)) {
        if (chunk) sentences.push(chunk);
      }
    }
  }
  return sentences;
}
