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
// 모델 = Supertone Supertonic 3(한국어 포함 31개어, 화자 10, 44.1kHz, OpenRAIL-M) HQ 팩:
// duration/text_encoder/vector_estimator 는 int8, **보코더만 원본 fp32**.
// 왜(2026-07-15 실측): int8 보코더가 청감 노이즈의 주범 — 무음 구간 플로어 −82dB 가 fp32
// 보코더로 −97dB(−15dB, 반복 실측). RTF 는 0.101→0.104 로 동일(보코더는 스텝 수와 무관한
// 1패스라 비용이 거의 없음) = 배속 파이프라인 예산 무손상. vector_estimator 까지 fp32 로
// 올리면 +178MB 에 이득 ~1dB 뿐이라 제외. num_steps(기본 5) 상향도 fp32 보코더 앞에서는
// 이득 0 이라 불채택 — 과거 "steps 8 개선" 실측은 int8 보코더 노이즈를 가린 것이었다.
// 팩 출처: k2-fsa int8 배포본 + Supertone/supertonic-3(HF) fp32 vocoder.onnx 교체,
// iswtts 릴리스 고정 태그(tts-models)에 자가 호스팅.
//
// ⚠️ 라이브러리의 레지스트리형 다운로드(ensureModelByCategory)를 쓰지 않는 이유(2026-07-06 실측):
// 그 경로는 모델 목록을 GitHub REST API(api.github.com)에서 읽는데, 무인증 60회/시간/IP
// 제한이라 통신사 NAT·공용 와이파이에서 403으로 즉사한다("다운로드 실패" 증상의 유력 원인).
// 릴리스 자산 직링크(github.com/.../releases/download/...)는 이 제한이 없어, 직링크 다운로드
// (expo-file-system) + 라이브러리 내장 해제기(extractTarBz2, libarchive)로 자가 관리한다.
const MODEL_URL =
  'https://github.com/insushim/iswtts/releases/download/tts-models/soribook-supertonic-3-hq.tar.bz2';
export const SHERPA_MODEL_MB = 195; // 다운로드 크기(해제 후 더 큼) — UI 안내용
// 아카이브 무결성 기준값(자가 호스팅 자산의 빌드 시 실측). 다운로드/재사용 아카이브는 해제
// 전에 정확한 크기+MD5 를 대조한다 — ①부분/손상 파일이 "95% 크기" 휴리스틱을 통과해 해제로
// 넘어가는 것 차단 ②릴리스 자산 교체·전송 오염 시 오염 바이너리가 네이티브 해제기·ONNX
// 런타임(신뢰경계 안)으로 들어가는 것 차단(교차검증 지적 2026-07-15). MD5 계산은
// expo-file-system 네이티브(getInfoAsync md5 옵션)라 204MB 도 수 초·JS 스레드 무점유.
// ⚠️ 모델 팩을 다시 만들면 이 두 값도 반드시 갱신할 것(불일치 = 무한 "손상" 오류).
const ARCHIVE_BYTES = 204512665;
const ARCHIVE_MD5 = 'acb045822a0559398e8fea1fab510621';
// 아카이브(195MB)+해제본(≈221MB)+여유. 부족 실패를 다운로드 후반이 아니라 시작 전에 알린다.
const REQUIRED_FREE_BYTES = 700 * 1024 * 1024;

const MODEL_DIR = `${documentDirectory}sherpa-models/supertonic-3-hq/`; // file:// URI
const READY_MARKER = `${MODEL_DIR}.ready`;
const ARCHIVE = `${cacheDirectory}supertonic-3-hq.tar.bz2`;
// 구(v1.18 이하) int8 모델의 흔적 — 새 팩과 무관하므로 발견 즉시 지워 저장공간을 회수한다
// (해제본 ~145MB, 받다 만 아카이브가 남아 있으면 +최대 122MB).
const LEGACY_PATHS = [
  `${documentDirectory}sherpa-models/supertonic-3/`,
  `${cacheDirectory}supertonic-3.tar.bz2`,
];

const plain = (uri: string) => uri.replace(/^file:\/\//, '');

export type DownloadProgress = {
  percent: number;
  phase?: 'downloading' | 'extracting';
};

// 구 모델 정리(1회, promise 캐시로 중복 IO 방지). ⚠️ 호출 시점 제한(교차검증 지적 2026-07-15):
// 앱 업데이트만 한 사용자의 구 데이터를 그 자리에서 지우면, 새 팩을 못/안 받는 사용자는
// (APK 다운그레이드로도) 오프라인 음성을 복구할 길이 사라진다. 그래서 삭제는
//   ① 사용자가 새 팩 다운로드를 시작할 때(공간 확보가 실제로 필요한 순간 = 마이그레이션 의사
//      표시. 여유공간 체크 전에 await — 회수분이 계산에 빠지면 경계 용량 기기에서 헛된
//      "공간 부족" 오류) 또는
//   ② 새 팩이 이미 READY 인 것을 확인한 뒤(잔재 정리)
// 두 경우에만 한다. 단순 상태 체크(미설치 상태)는 구 데이터를 건드리지 않는다.
let legacySweep: Promise<void> | null = null;
function sweepLegacyModel(): Promise<void> {
  if (!legacySweep) {
    legacySweep = Promise.all(
      LEGACY_PATHS.map((p) => deleteAsync(p, { idempotent: true }).catch(() => { /* 없음/실패 — 무해 */ })),
    ).then(() => undefined);
  }
  return legacySweep;
}

export async function isSherpaModelReady(): Promise<boolean> {
  try {
    const ready = (await getInfoAsync(READY_MARKER)).exists;
    if (ready) void sweepLegacyModel(); // 새 팩 확보 확인 후에만 잔재 정리(위 ②)
    return ready;
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
  // 구 모델 정리를 먼저 끝낸다 — 회수된 공간까지 반영된 값으로 여유공간을 판정.
  await sweepLegacyModel();
  const free = await getFreeDiskStorageAsync().catch(() => Number.MAX_SAFE_INTEGER);
  if (free < REQUIRED_FREE_BYTES) {
    throw new Error('저장 공간이 부족합니다 — 약 750MB의 여유 공간이 필요합니다.');
  }

  // 1) 다운로드(직링크). 이전에 받다 만/받아 둔 아카이브가 있으면 재사용해 해제부터 시도.
  // 재사용 판정은 정확한 크기 일치(휴리스틱 아님) — 최종 무결성은 아래 2)의 MD5 가 확정한다.
  const info = await getInfoAsync(ARCHIVE);
  const looksComplete = info.exists && info.size === ARCHIVE_BYTES;
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

  // 2) 무결성 검증(크기+MD5, 상수 주석 참조) — 통과한 아카이브만 해제기로 들어간다.
  emit({ percent: 0, phase: 'extracting' });
  const verify = await getInfoAsync(ARCHIVE, { md5: true });
  if (isCancelled()) throw new Error('aborted');
  if (!verify.exists || verify.size !== ARCHIVE_BYTES || verify.md5 !== ARCHIVE_MD5) {
    await deleteAsync(ARCHIVE, { idempotent: true }).catch(() => { /* noop */ });
    throw new Error('받은 음성 데이터가 손상되었습니다 — 다시 시도해주세요.');
  }

  // 3) 해제(라이브러리 내장 libarchive). 취소 신호는 AbortSignal 로 전달.
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

  // 4) 구성 확인 후 완료 마킹 + 아카이브 정리(저장공간). 해제기의 "성공"만 믿지 않고
  // 핵심 파일(tts.json)이 실제로 풀렸는지 확인해야 READY = 로드 가능이 성립한다
  // (교차검증 지적 2026-07-15). 아카이브는 최상위 폴더 하나를 만들 수 있다(sherpaModelPath
  // 의 하강 로직과 동일 규칙).
  const names = (await readDirectoryAsync(MODEL_DIR).catch(() => [] as string[])).filter(
    (n) => !n.startsWith('.'),
  );
  const root = names.includes('tts.json') || names.length !== 1 ? MODEL_DIR : `${MODEL_DIR}${names[0]}/`;
  if (!(await getInfoAsync(`${root}tts.json`)).exists) {
    await deleteAsync(MODEL_DIR, { idempotent: true }).catch(() => { /* noop */ });
    await deleteAsync(ARCHIVE, { idempotent: true }).catch(() => { /* noop */ });
    throw new Error('음성 데이터 구성이 올바르지 않습니다 — 다시 시도해주세요.');
  }
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
