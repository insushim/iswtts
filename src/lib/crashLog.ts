import { File, Paths } from 'expo-file-system';

// 로컬 크래시 로그 — 사이드로드 앱이라 외부 서비스(Sentry) 없이 기기 안에만 남긴다.
// JS 치명 오류 발생 시 동기 write로 파일에 기록 → 다음 실행 때 사용자에게 1회 안내.
// (신 expo-file-system File API의 write/textSync는 동기라 크래시로 프로세스가 죽기 전에 확실히 남는다.)

const FILE_NAME = 'last-crash.txt';

function crashFile(): File {
  return new File(Paths.document, FILE_NAME);
}

export function installCrashLogger(appVersion: string): void {
  const EU = (globalThis as any).ErrorUtils;
  if (!EU?.setGlobalHandler) return;
  const prev = EU.getGlobalHandler?.();
  EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    try {
      const e = error as { message?: unknown; stack?: unknown } | null;
      const f = crashFile();
      if (!f.exists) f.create();
      f.write(
        [
          `time: ${new Date().toISOString()}`,
          `version: ${appVersion}`,
          `fatal: ${!!isFatal}`,
          `message: ${String(e?.message ?? error)}`,
          `stack: ${String(e?.stack ?? '').slice(0, 4000)}`,
        ].join('\n'),
      );
    } catch {
      /* 로그 기록 실패가 원래 크래시 처리를 막으면 안 됨 */
    }
    prev?.(error, isFatal);
  });
}

export function readLastCrash(): string | null {
  try {
    const f = crashFile();
    if (!f.exists) return null;
    return f.textSync();
  } catch {
    return null;
  }
}

export function clearLastCrash(): void {
  try {
    const f = crashFile();
    if (f.exists) f.delete();
  } catch {
    /* noop */
  }
}
