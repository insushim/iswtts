import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  documentDirectory,
  makeDirectoryAsync,
  writeAsStringAsync,
  readAsStringAsync,
  deleteAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';
import type { Doc, DocFormat } from '../types';
import { segmentSentences } from '../lib/segment';

const DOCS_DIR = `${documentDirectory}docs/`;

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
  loadSentences: (id: string) => Promise<string[]>;
  setProgress: (id: string, lastIndex: number, total: number) => void;
  remove: (id: string) => Promise<void>;
};

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      docs: [],

      addFromText: async ({ title, format, text }) => {
        const sentences = segmentSentences(text);
        if (sentences.length === 0) return null;
        await ensureDir();
        const id = newId();
        await writeAsStringAsync(
          `${DOCS_DIR}${id}.json`,
          JSON.stringify({ id, sentences }),
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

      loadSentences: async (id) => {
        const raw = await readAsStringAsync(`${DOCS_DIR}${id}.json`);
        const parsed = JSON.parse(raw) as { sentences: string[] };
        return parsed.sentences || [];
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
