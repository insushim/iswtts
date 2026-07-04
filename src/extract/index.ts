import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import type { DocFormat } from '../types';
import { extractTxt } from './txt';
import { extractEpub } from './epub';
import { extractPdf } from './pdfBridge';

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

  let text = '';
  if (format === 'pdf') {
    const b64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 });
    text = await extractPdf(b64);
  } else if (format === 'epub') {
    text = await extractEpub(asset.uri);
  } else {
    text = await extractTxt(asset.uri);
  }

  return { title, format, text: (text || '').trim() };
}
