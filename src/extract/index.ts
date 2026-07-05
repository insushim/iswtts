import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, deleteAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import type { DocFormat } from '../types';
import { extractTxt } from './txt';
import { extractEpub } from './epub';
import { extractPdf } from './pdfBridge';

// 파일 전체를 메모리(base64/문자열)에 올리는 구조라 크기 상한이 필요 — 초과 시 OOM 크래시 대신 안내.
const MAX_SIZE: Record<string, number> = {
  pdf: 80 * 1024 * 1024, // base64 ≈ 107MB 문자열 + WebView 사본
  epub: 80 * 1024 * 1024,
  default: 30 * 1024 * 1024, // txt/md/html
};

export type ImportResult = { title: string; format: DocFormat; text: string };

function formatFromName(name: string): DocFormat {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'epub') return 'epub';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'htm' || ext === 'html') return 'html';
  return 'txt';
}

// 파일 선택 → 포맷별 추출. 사용자가 취소하면 null.
export async function importDocument(): Promise<ImportResult | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: [
      'text/plain',
      'text/markdown',
      'text/html',
      'application/pdf',
      'application/epub+zip',
      'application/octet-stream',
      '*/*',
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;

  const asset = res.assets[0];
  const name = asset.name || 'document';
  const title = name.replace(/\.[^.]+$/, '');
  const format = formatFromName(name);

  const limit = MAX_SIZE[format] ?? MAX_SIZE.default;
  if (asset.size != null && asset.size > limit) {
    throw new Error(
      `파일이 너무 큽니다 (${Math.round(asset.size / 1024 / 1024)}MB). ${Math.round(limit / 1024 / 1024)}MB 이하 파일만 지원합니다.`,
    );
  }

  let text = '';
  try {
    if (format === 'pdf') {
      const b64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 });
      text = await extractPdf(b64);
    } else if (format === 'epub') {
      text = await extractEpub(asset.uri);
    } else {
      text = await extractTxt(asset.uri);
    }
  } finally {
    // copyToCacheDirectory로 복사된 원본은 추출 후 불필요 — 대용량 누적 방지.
    if (cacheDirectory && asset.uri.startsWith(cacheDirectory)) {
      deleteAsync(asset.uri, { idempotent: true }).catch(() => { /* noop */ });
    }
  }

  return { title, format, text: (text || '').trim() };
}
