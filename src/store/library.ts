import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  documentDirectory,
  makeDirectoryAsync,
  writeAsStringAsync,
  readAsStringAsync,
  deleteAsync,
  moveAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';
import type { Doc, DocFormat } from '../types';
import { segmentDocument } from '../lib/segment';
import { buildRepairIndex, repairFakeSpaces } from '../lib/dewrap';

const DOCS_DIR = `${documentDirectory}docs/`;

// 저장 문서 스키마 버전. 2 = 고정폭 하드랩의 "가짜 공백"이 정리된 문장(v1.27.3).
// 그 이전(버전 없음)에 추가된 책은 loadDoc 이 1회 복원하고 이 표식을 남긴다 — 복원은
// **문장 수·순서를 바꾸지 않으므로**(공백만 제거) 읽던 위치(lastIndex)가 그대로 보존된다.
const DOC_SCHEMA = 2;

async function ensureDir() {
  const info = await getInfoAsync(DOCS_DIR);
  if (!info.exists) await makeDirectoryAsync(DOCS_DIR, { intermediates: true });
}

function newId() {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export type LibraryState = {
  docs: Doc[];
  addFromText: (args: {
    title: string;
    format: DocFormat;
    text: string;
  }) => Promise<Doc | null>;
  // 문장 + 문단 시작 인덱스(낭독 페이스용). 구버전 문서(paraStarts 미저장)는 빈 배열 —
  // 문단 호흡만 빠지고 나머지 페이스 변주는 그대로 동작한다.
  loadDoc: (id: string) => Promise<{ sentences: string[]; paraStarts: number[] }>;
  setProgress: (id: string, lastIndex: number, total: number) => void;
  remove: (id: string) => Promise<void>;
};

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      docs: [],

      addFromText: async ({ title, format, text }) => {
        const { sentences, paraStarts } = segmentDocument(text);
        if (sentences.length === 0) return null;
        await ensureDir();
        const id = newId();
        await writeAsStringAsync(
          `${DOCS_DIR}${id}.json`,
          JSON.stringify({ id, sentences, paraStarts, v: DOC_SCHEMA }),
        );
        const doc: Doc = {
          id,
          title: title || '제목 없음',
          format,
          createdAt: Date.now(),
          sentenceCount: sentences.length,
          progress: 0,
          lastIndex: 0,
        };
        set({ docs: [doc, ...get().docs] });
        return doc;
      },

      loadDoc: async (id) => {
        const raw = await readAsStringAsync(`${DOCS_DIR}${id}.json`);
        const parsed = JSON.parse(raw) as {
          sentences: string[];
          paraStarts?: number[];
          v?: number;
        };
        const sentences = parsed.sentences || [];
        const paraStarts = parsed.paraStarts || [];
        if (parsed.v === DOC_SCHEMA || sentences.length === 0) {
          return { sentences, paraStarts };
        }
        // 구버전 문서 1회 복원(DOC_SCHEMA 주석): 문서 전체 빈도로 "단어 중간 가짜 공백"만
        // 지운다. 실측(초한지 코퍼스): 가짜 공백의 72%를 정밀도 96.7%로 제거, 애초에 가짜
        // 공백이 없는 정상 문서에서는 전체 공백의 0.09%만 건드린다(대부분 "한 번"→"한번"
        // 류의 무해한 붙여쓰기). 실패해도 원본을 그대로 쓴다 — 낭독을 막지 않는 것이 우선.
        const idx = buildRepairIndex(sentences);
        const repaired = sentences.map((s) => repairFakeSpaces(s, idx));
        // 저장은 best-effort — 실패해도 이번 세션은 복원본으로 읽고 다음 열기에서 다시 시도한다.
        // 큰 문서(수 MB)를 제자리에 덮어쓰다 앱이 죽으면 책이 통째로 깨지므로 임시 파일에 쓰고
        // 교체한다. 교체 단계가 실패하면 원본이 이미 지워졌을 수 있으니 직접 쓰기로 복구한다.
        const body = JSON.stringify({ id, sentences: repaired, paraStarts, v: DOC_SCHEMA });
        const main = `${DOCS_DIR}${id}.json`;
        const tmp = `${main}.tmp`;
        try {
          await writeAsStringAsync(tmp, body);
          await deleteAsync(main, { idempotent: true });
          await moveAsync({ from: tmp, to: main });
        } catch {
          try {
            await writeAsStringAsync(main, body);
            await deleteAsync(tmp, { idempotent: true });
          } catch {
            /* 다음 열기에서 다시 시도 */
          }
        }
        return { sentences: repaired, paraStarts };
      },

      setProgress: (id, lastIndex, total) => {
        set({
          docs: get().docs.map((d) =>
            d.id === id
              ? {
                  ...d,
                  lastIndex,
                  progress: total > 0 ? Math.min(1, (lastIndex + 1) / total) : 0,
                }
              : d,
          ),
        });
      },

      remove: async (id) => {
        try {
          await deleteAsync(`${DOCS_DIR}${id}.json`, { idempotent: true });
        } catch {
          /* 파일이 이미 없을 수 있음 */
        }
        set({ docs: get().docs.filter((d) => d.id !== id) });
      },
    }),
    {
      name: 'iwtts-library',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ docs: s.docs }),
    },
  ),
);
