// 오프라인(sherpa) 재생 파이프라인 계측 — "배속에서 속도가 왔다 갔다/씹힌다"의 원인을
// 추측이 아니라 기기 실측으로 확정하기 위한 최소 통계.
//
// 왜 필요한가(2026-07-13): 합성 오디오 자체는 온전하다(맥 실측 Whisper CER: 자연속도 0.7%,
// 1.5× 재생 스트레치 0.0% — 스트레치는 무해). 남은 원인은 "재생이 합성을 앞질러 캐시가 마르는
// 것"(문장·세그먼트 경계 대기 → 리듬 흔들림)뿐인데, 그 판정은 기기 CPU 성능에 달려 있어
// 개발 PC 에서는 재현되지 않는다(맥 RTF 0.11 — 안드로이드 중급기 추정 0.5~1.1).
// → 기기가 스스로 재고, 설정 화면에 보여주고, 못 따라가면 사용자에게 알린다.

export type SherpaStats = {
  /** 합성 완료 건수 */
  synths: number;
  /** 합성 소요 ÷ 합성된 오디오 길이(자연속도 기준). 1.0 = 실시간과 동률 */
  avgRtf: number;
  /** 재생이 합성을 앞질러 발화 시작을 기다린 횟수(캐시 마름) */
  starved: number;
  /** 그 대기의 총합(ms) */
  starvedMs: number;
  /** 마지막 대기 시각(ms epoch) — 알림 스로틀용 */
  lastStarvedAt: number;
  /**
   * 발화 "도중" 재생이 벽시계만큼 전진하지 못한 시간(ms) — 오디오 언더런/스톨의 직접 증거.
   * starvedMs 와 짝을 이뤄 두 가설을 가른다:
   *   starvedMs 큼 · stallMs≈0  → 합성이 재생을 못 따라감(파이프라인 마름)
   *   starvedMs≈0 · stallMs 큼  → 재생 자체가 끊김(Sonic 스트레치·디코드 언더런, CPU 경합)
   */
  stallMs: number;
};

const stats: SherpaStats = {
  synths: 0,
  avgRtf: 0,
  starved: 0,
  starvedMs: 0,
  lastStarvedAt: 0,
  stallMs: 0,
};

// 최근 성능에 반응하는 지수가중이동평균(EWMA). 단순 누적평균이면 표본이 쌓일수록 최근 건의
// 영향이 1/n 로 희석돼, 장시간 낭독 중 발열 스로틀링으로 후반부가 느려지는 상황(= 사용자가
// 실제로 겪는 순간)을 못 잡는다(교차검증 지적 2026-07-13). α=0.3 ≈ 최근 ~6건 반영.
const RTF_ALPHA = 0.3;

export function recordSynth(elapsedMs: number, audioMs: number): void {
  if (!(audioMs > 0) || !(elapsedMs >= 0)) return;
  const rtf = elapsedMs / audioMs;
  stats.avgRtf = stats.synths === 0 ? rtf : stats.avgRtf + RTF_ALPHA * (rtf - stats.avgRtf);
  stats.synths += 1;
}

// 발화 시작을 기다린 시간. 짧은 대기(프레임 몇 개)는 리듬에 안 잡히므로 무시한다.
const STARVE_MIN_MS = 150;

export function recordStarvation(waitMs: number, now: number): void {
  if (waitMs < STARVE_MIN_MS) return;
  stats.starved += 1;
  stats.starvedMs += waitMs;
  stats.lastStarvedAt = now;
}

// 재생 진행 감시: 두 상태 이벤트 사이에 오디오 위치가 "벽시계 × 배속"만큼 전진했는가.
// 못 전진한 몫이 곧 사용자가 듣는 끊김/씹힘이다.
//
// 임계 0.7: 이벤트 타이밍 지터(updateInterval 80ms)와 앱 백그라운드 전환으로 벽시계만
// 흐르는 구간이 있어 완만하게 잡는다. 벽시계 델타가 비정상적으로 큰 구간(백그라운드 복귀,
// 화면 꺼짐)은 아예 버린다 — 그건 재생 결함이 아니다.
const PROGRESS_OK = 0.7;
const WALL_MAX_MS = 1500;

export function recordPlaybackProgress(wallMs: number, positionMs: number, rate: number): void {
  if (!(wallMs > 0) || wallMs > WALL_MAX_MS) return;
  if (!(rate > 0) || positionMs < 0) return;
  const expected = wallMs * rate;
  const progress = positionMs / expected;
  if (progress >= PROGRESS_OK) return;
  // 기대만큼 못 간 시간(벽시계 기준)을 끊김으로 적립.
  stats.stallMs += wallMs * (1 - Math.max(0, Math.min(1, progress)));
}

export function sherpaStats(): SherpaStats {
  return { ...stats };
}

export function resetSherpaStats(): void {
  stats.synths = 0;
  stats.avgRtf = 0;
  stats.starved = 0;
  stats.starvedMs = 0;
  stats.lastStarvedAt = 0;
  stats.stallMs = 0;
}
