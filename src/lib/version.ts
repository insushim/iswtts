// 시맨틱 버전 비교(순수 함수 — appUpdate에서 분리해 단위테스트 가능하게).
// latest > current → 1, latest < current → -1, 같으면 0.
export function compareVersions(current: string, latest: string): number {
  const c = current.replace(/^v/, '').split('.').map(Number);
  const l = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (lv > cv) return 1;
    if (lv < cv) return -1;
  }
  return 0;
}
