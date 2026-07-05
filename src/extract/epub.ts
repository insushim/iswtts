import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { stripTagBlocks } from '../lib/html';

// EPUB(=zip) 온디바이스 텍스트 추출. container.xml → OPF → spine 순서대로 XHTML 본문 추출.
export async function extractEpub(uri: string): Promise<string> {
  const b64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  const zip = await JSZip.loadAsync(b64, { base64: true });

  // 1) META-INF/container.xml 에서 OPF 경로
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('EPUB 형식이 아닙니다 (container.xml 없음)');
  const containerXml = await containerFile.async('string');
  const opfPath = /full-path="([^"]+)"/i.exec(containerXml)?.[1];
  if (!opfPath) throw new Error('EPUB OPF 경로를 찾지 못했습니다');

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('EPUB OPF 파일이 없습니다');
  const opf = await opfFile.async('string');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2) manifest: id -> href
  const manifest: Record<string, string> = {};
  for (const m of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
    const tag = m[0];
    const id = /id="([^"]+)"/i.exec(tag)?.[1];
    const href = /href="([^"]+)"/i.exec(tag)?.[1];
    if (id && href) manifest[id] = href;
  }

  // 3) spine 순서
  const spineIds: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"[^>]*\/?>/gi)) {
    spineIds.push(m[1]);
  }

  const hrefs = spineIds.map((id) => manifest[id]).filter(Boolean);
  const parts: string[] = [];
  for (const href of hrefs) {
    const path = decodeURIComponent(baseDir + href.split('#')[0]);
    const f = zip.file(path);
    if (!f) continue;
    const html = await f.async('string');
    parts.push(htmlToText(html));
  }
  const text = parts.join('\n\n').trim();
  if (!text) throw new Error('EPUB에서 읽을 텍스트를 찾지 못했습니다');
  return text;
}

function htmlToText(html: string): string {
  // stripTagBlocks: 기존 [\s\S]*? 정규식의 O(n²) 폭주(손상 파일 ANR) 회피 — src/lib/html.ts 참조.
  let t = stripTagBlocks(html, 'script');
  t = stripTagBlocks(t, 'style');
  t = stripTagBlocks(t, 'head');
  return t
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}
