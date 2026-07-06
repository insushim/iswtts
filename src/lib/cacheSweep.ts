import { cacheDirectory, readDirectoryAsync, deleteAsync } from 'expo-file-system/legacy';

// 앱 기동 시 캐시 잔존물 청소.
// - edge-*.mp3 / sherpa-*.wav: 재생/합성 도중 프로세스가 강제 종료되면 deleteAsync 전에 남을 수 있다(누적 방지).
// - SoriBook-*.apk: 자가 업데이트로 받은 설치 파일(설치 후엔 불필요, 회당 ~80MB).
// 기동 직후(재생 시작 전)에만 부르므로 사용 중 파일을 지울 일이 없다.
export async function sweepCache(): Promise<void> {
  if (!cacheDirectory) return;
  try {
    const names = await readDirectoryAsync(cacheDirectory);
    const targets = names.filter(
      (n) =>
        (n.startsWith('edge-') && n.endsWith('.mp3')) ||
        (n.startsWith('sherpa-') && n.endsWith('.wav')) ||
        (n.startsWith('SoriBook-') && n.endsWith('.apk')),
    );
    await Promise.all(
      targets.map((n) => deleteAsync(`${cacheDirectory}${n}`, { idempotent: true }).catch(() => { /* noop */ })),
    );
  } catch {
    /* 캐시 청소 실패는 치명적이지 않음 */
  }
}
