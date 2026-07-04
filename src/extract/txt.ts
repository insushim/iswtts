import { readAsStringAsync } from 'expo-file-system/legacy';

// TXT / MD / HTML 텍스트 추출. (v1은 UTF-8 가정 — EUC-KR 등은 후속.)
export async function extractTxt(uri: string): Promise<string> {
  const raw = await readAsStringAsync(uri);
  return stripIfHtml(raw);
}

function stripIfHtml(s: string): string {
  if (!/<\/?[a-z][\s\S]*>/i.test(s)) return s;
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
