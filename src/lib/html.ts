// HTML 블록 태그(<script>…</script> 등) 제거 유틸.
// 기존 /<script[\s\S]*?<\/script>/gi 정규식은 닫는 태그 없는 입력에서 O(n²)로 폭주
// (실측: 여는 태그 20만 반복 = 50초 멈춤/ANR) → indexOf 기반 단일 패스로 대체.
export function stripTagBlocks(s: string, tag: string): string {
  const lower = s.toLowerCase();
  const open = '<' + tag;
  const close = '</' + tag;
  let out = '';
  let pos = 0;
  for (;;) {
    const i = lower.indexOf(open, pos);
    if (i < 0) {
      out += s.slice(pos);
      break;
    }
    // '<script' 바로 뒤가 태그명의 연장이면(예: <scripts>) 매치가 아니다.
    const ch = i + open.length < s.length ? lower.charCodeAt(i + open.length) : -1;
    const isDelim = ch < 0 || ch === 62 /*>*/ || ch === 47 /*/*/ || ch === 32 || ch === 9 || ch === 10 || ch === 13;
    if (!isDelim) {
      out += s.slice(pos, i + open.length);
      pos = i + open.length;
      continue;
    }
    const j = lower.indexOf(close, i + open.length);
    if (j < 0) {
      // 닫는 태그 없음 → 기존 정규식과 동일하게 제거하지 않고 그대로 둔다
      // (이후 일반 <[^>]+> 제거 단계가 태그만 벗겨낸다).
      out += s.slice(i);
      break;
    }
    out += s.slice(pos, i) + ' ';
    const gt = s.indexOf('>', j);
    pos = gt < 0 ? s.length : gt + 1;
  }
  return out;
}
