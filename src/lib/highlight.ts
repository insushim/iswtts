// 현재 문장을 [앞 · 하이라이트 단어 · 뒤]로 분해 — PlayerScreen 자막 렌더에서 사용.
export function splitHighlight(
  sentence: string,
  wordStart: number,
  wordLen: number,
): { before: string; word: string; after: string } {
  if (wordLen <= 0) return { before: sentence, word: '', after: '' };
  const end = wordStart + wordLen;
  return {
    before: sentence.slice(0, wordStart),
    word: sentence.slice(wordStart, end),
    after: sentence.slice(end),
  };
}
