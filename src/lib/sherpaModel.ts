import {
  documentDirectory,
  cacheDirectory,
  createDownloadResumable,
  getInfoAsync,
  deleteAsync,
  makeDirectoryAsync,
  readDirectoryAsync,
  writeAsStringAsync,
  getFreeDiskStorageAsync,
  type DownloadResumable,
} from 'expo-file-system/legacy';
import { extractTarBz2 } from 'react-native-sherpa-onnx/download';

// sherpa-onnx 오프라인 신경망 모델 관리(다운로드/해제/상태/삭제).
// 모델 = Supertone Supertonic 3 int8(한국어 포함 31개어, 화자 10, 24kHz, OpenRAIL-M).
//
// ⚠️ 라이브러리의 레지스트리형 다운로드(ensureModelByCategory)를 쓰지 않는 이유(2026-07-06 실측):
// 그 경로는 모델 목록을 GitHub REST API(api.github.com)에서 읽는데, 무인증 60회/시간/IP
// 제한이라 통신사 NAT·공용 와이파이에서 403으로 즉사한다("다운로드 실패" 증상의 유력 원인).
// 릴리스 자산 직링크(github.com/.../releases/download/...)는 이 제한이 없어, 직링크 다운로드
// (expo-file-system) + 라이브러리 내장 해제기(extractTarBz2, libarchive)로 자가 관리한다.
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2';
export const SHERPA_MODEL_MB = 122; // 다운로드 크기(해제 후 더 큼) — UI 안내용
// 아카이브(122MB)+해제본(≈2배)+여유. 부족 실패를 다운로드 후반이 아니라 시작 전에 알린다.
const REQUIRED_FREE_BYTES = 450 * 1024 * 1024;

const MODEL_DIR = `${documentDirectory}sherpa-models/supertonic-3/`; // file:// URI
const READY_MARKER = `${MODEL_DIR}.ready`;
const ARCHIVE = `${cacheDirectory}supertonic-3.tar.bz2`;

const plain = (uri: string) => uri.replace(/^file:\/\//, '');

export type DownloadProgress = {
  percent: number;
  phase?: 'downloading' | 'extracting';
};

export async function isSherpaModelReady(): Promise<boolean> {
  try {
    return (await getInfoAsync(READY_MARKER)).exists;
  } catch {
    return false;
  }
}

// createTTS 에 넘길 모델 디렉토리의 절대경로(file:// 없이). 아카이브가 하위 폴더를 만들 수
// 있어 실제 모델 파일(tts.json 등)이 있는 위치를 찾아 내려간다. 미설치면 null.
export async function sherpaModelPath(): Promise<string | null> {
  try {
    if (!(await isSherpaModelReady())) return null;
    const names = (await readDirectoryAsync(MODEL_DIR)).filter((n) => !n.startsWith('.'));
    if (names.includes('tts.json') || names.some((n) => n.endsWith('.onnx'))) {
      return plain(MODEL_DIR);
    }
    if (names.length === 1) return plain(`${MODEL_DIR}${names[0]}`);
    return plain(MODEL_DIR);
  } catch {
    return null;
  }
}

// 다운로드는 모듈 레벨 싱글턴 — 설정 화면을 나갔다 와도 진행 중 상태를 다시 붙잡을 수 있고,
// 중복 시작(동일 파일 동시 다운로드 충돌)을 원천 차단한다.
type ProgressFn = (p: DownloadProgress) => void;
let activeDl: {
  promise: Promise<void>;
  listeners: Set<ProgressFn>;
  cancel: () => void;
} | null = null;

export function isSherpaDownloadActive(): boolean {
  return activeDl !== null;
}

export function cancelSherpaDownload(): void {
  activeDl?.cancel();
}

async function runDownload(emit: ProgressFn, isCancelled: () => boolean, setCanceller: (fn: () => void) => void): Promise<void> {
  const free = await getFreeDiskStorageAsync().catch(() => Number.MAX_SAFE_INTEGER);
  if (free < REQUIRED_FREE_BYTES) {
    throw new Error('저장 공간이 부족합니다 — 약 450MB의 여유 공간이 필요합니다.');
  }

  // 1) 다운로드(직링크). 이전에 받다 만/받아 둔 아카이브가 있으면 재사용해 해제부터 시도.
  const info = await getInfoAsync(ARCHIVE);
  const looksComplete = info.exists && (info.size ?? 0) > SHERPA_MODEL_MB * 1024 * 1024 * 0.95;
  if (!looksComplete) {
    if (info.exists) await deleteAsync(ARCHIVE, { idempotent: true });
    let resumable: DownloadResumable | null = null;
    resumable = createDownloadResumable(MODEL_URL, ARCHIVE, {}, (p) => {
      const total = p.totalBytesExpectedToWrite || 0;
      const percent = total > 0 ? Math.round((p.totalBytesWritten / total) * 100) : 0;
      emit({ percent, phase: 'downloading' });
    });
    setCanceller(() => {
      resumable?.cancelAsync().catch(() => { /* noop */ });
    });
    const res = await resumable.downloadAsync();
    if (isCancelled()) {
      await deleteAsync(ARCHIVE, { idempotent: true }).catch(() => { /* noop */ });
      throw new Error('aborted');
    }
    if (!res || (res.status !== 200 && res.status !== 206)) {
      await deleteAsync(ARCHIVE, { idempotent: true }).catch(() => { /* noop */ });
      throw new Error(`다운로드 응답 오류 (HTTP ${res?.status ?? '없음'})`);
    }
  }

  // 2) 해제(라이브러리 내장 libarchive). 취소 신호는 AbortSignal 로 전달.
  emit({ percent: 0, phase: 'extracting' });
  await deleteAsync(MODEL_DIR, { idempotent: true }).catch(() => { /* noop */ });
  await makeDirectoryAsync(MODEL_DIR, { intermediates: true });
  const extractAbort = new AbortController();
  setCanceller(() => extractAbort.abort());
  const result = await extractTarBz2(
    plain(ARCHIVE),
    plain(MODEL_DIR),
    true,
    (e: { percent: number }) => emit({ percent: Math.round(e.percent), phase: 'extracting' }),
    extractAbort.signal,
  );
  if (isCancelled()) throw new Error('aborted');
  if (!result.success) {
    // 해제 실패한 아카이브는 손상 가능성 — 다음 시도에서 새로 받도록 지운다.
    await deleteAsync(ARCHIVE, { idempotent: true }).catch(() => { /* noop */ });
    throw new Error(`음성 데이터 해제 실패${result.reason ? ` (${result.reason})` : ''}`);
  }

  // 3) 완료 마킹 + 아카이브 정리(저장공간).
  await writeAsStringAsync(READY_MARKER, 'ok');
  await deleteAsync(ARCHIVE, { idempotent: true }).catch(() => { /* noop */ });
}

// 단일 진입점: 이미 진행 중이면 그 작업에 합류. detach 로 진행률 리스너만 떼어낼 수 있다
// (화면 unmount 시 — 다운로드 자체는 계속).
export function downloadSherpaModel(onProgress: ProgressFn): {
  promise: Promise<void>;
  detach: () => void;
} {
  if (activeDl) {
    const dl = activeDl;
    dl.listeners.add(onProgress);
    return { promise: dl.promise, detach: () => dl.listeners.delete(onProgress) };
  }
  const listeners = new Set<ProgressFn>([onProgress]);
  let cancelled = false;
  let canceller: (() => void) | null = null;
  const cancel = () => {
    cancelled = true;
    canceller?.();
  };
  const promise = runDownload(
    (p) => {
      for (const fn of listeners) fn(p);
    },
    () => cancelled,
    (fn) => {
      canceller = fn;
      if (cancelled) fn(); // 취소가 canceller 등록보다 먼저 눌린 경우 즉시 반영
    },
  ).finally(() => {
    activeDl = null;
  });
  activeDl = { promise, listeners, cancel };
  return { promise, detach: () => listeners.delete(onProgress) };
}

export async function deleteSherpaModel(): Promise<void> {
  try {
    await deleteAsync(MODEL_DIR, { idempotent: true });
    await deleteAsync(ARCHIVE, { idempotent: true });
  } catch {
    /* 이미 없음 등 — 무시 */
  }
}
