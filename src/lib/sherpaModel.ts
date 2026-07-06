import {
  ensureModelByCategory,
  isModelDownloadedByCategory,
  getLocalModelPathByCategory,
  deleteModelByCategory,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import type { DownloadProgress, DownloadResult } from 'react-native-sherpa-onnx/download';

// sherpa-onnx 오프라인 신경망 모델 관리(다운로드/상태/삭제).
// 모델 = Supertone Supertonic 3 int8(한국어 포함 31개어, 화자 10, 24kHz, OpenRAIL-M).
// 다운로드 원본 = k2-fsa/sherpa-onnx GitHub 릴리스(tts-models 태그) — 라이브러리 레지스트리가
// 릴리스 자산 목록을 직접 읽으므로 별도 호스팅 불필요. id = 자산 파일명에서 .tar.bz2 제거.
export const SHERPA_MODEL_ID = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11';
export const SHERPA_MODEL_MB = 122; // 다운로드 크기(해제 후 더 큼) — UI 안내용

export type { DownloadProgress };

export async function isSherpaModelReady(): Promise<boolean> {
  try {
    return await isModelDownloadedByCategory(ModelCategory.Tts, SHERPA_MODEL_ID);
  } catch {
    return false;
  }
}

// 모델 디렉토리의 실제 경로(중첩 폴더 자동 해석). 미설치면 null.
export async function sherpaModelPath(): Promise<string | null> {
  try {
    return await getLocalModelPathByCategory(ModelCategory.Tts, SHERPA_MODEL_ID);
  } catch {
    return null;
  }
}

// 다운로드는 모듈 레벨 싱글턴 — 설정 화면을 나갔다 와도 진행 중 상태를 다시 붙잡을 수 있고,
// 중복 시작(동일 모델 동시 다운로드 충돌)을 원천 차단한다.
type ProgressFn = (p: DownloadProgress) => void;
let activeDl: {
  promise: Promise<DownloadResult>;
  listeners: Set<ProgressFn>;
  controller: AbortController;
} | null = null;

export function isSherpaDownloadActive(): boolean {
  return activeDl !== null;
}

export function cancelSherpaDownload(): void {
  activeDl?.controller.abort();
}

// 다운로드+해제+중단 재개까지 단일 진입점(ensureModel). 이미 진행 중이면 그 작업에 합류.
// detach: 화면 unmount 시 진행률 리스너를 떼어낸다(들락거릴 때 죽은 리스너 누적 방지).
export function downloadSherpaModel(onProgress: ProgressFn): {
  promise: Promise<DownloadResult>;
  detach: () => void;
} {
  if (activeDl) {
    const dl = activeDl;
    dl.listeners.add(onProgress);
    return { promise: dl.promise, detach: () => dl.listeners.delete(onProgress) };
  }
  const controller = new AbortController();
  const listeners = new Set<ProgressFn>([onProgress]);
  const promise = ensureModelByCategory<never>(ModelCategory.Tts, SHERPA_MODEL_ID, {
    onProgress: (p: DownloadProgress) => {
      for (const fn of listeners) fn(p);
    },
    signal: controller.signal,
    deleteArchiveAfterExtract: true, // 122MB 아카이브는 해제 후 즉시 삭제(저장공간)
  }).finally(() => {
    activeDl = null;
  }) as Promise<DownloadResult>;
  activeDl = { promise, listeners, controller };
  return { promise, detach: () => listeners.delete(onProgress) };
}

export async function deleteSherpaModel(): Promise<void> {
  try {
    await deleteModelByCategory(ModelCategory.Tts, SHERPA_MODEL_ID);
  } catch {
    /* 이미 없음 등 — 무시 */
  }
}
