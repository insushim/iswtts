// sherpa(Supertonic) 배속 매핑(순수 함수 — 테스트 대상).
//
// 사용자 방침(2026-07-06): 배속 상한 두지 않음 — 설정 배속은 무조건 그 속도로 재생하고
// 품질 판단은 사용자가 한다. 단 같은 속도에서 가장 잘 들리는 분담을 쓴다(Whisper CER 실측):
// - 모델 speed 솔로: 1.2=14%(온전), 1.5=26%, 2.0=72%, 3.0=82%, ≥4.0=전구간 무음.
// - 재생 스트레치(피치보정) 솔로(자연속도 소스): 2.0=10%, 3.0=18%, 3.2=22%, 3.5=62%(절벽).
// - 총 3.2× 초과에서는 "스트레치 3.0 고정 + 초과분 모델"이 순수 스트레치보다 우수
//   (3.6×: 조합38% vs 순수62% / 4.0×: 조합48% vs 순수76%).
// → 분담: 스트레치가 3.0까지 우선 → 초과분은 모델(무음 경계 3.0 클램프) → 9× 초과 잔여는
//   다시 스트레치(하드맥스 10, expo-audio 패치 상한과 일치).
// + 스마트 스피드(v1.11.0): >3×에서는 합성 오디오의 긴 쉼을 먼저 압축(smartSpeed.ts,
//   왜곡 0 배속 f≈1.1~1.3)하고, 그만큼 스트레치를 덜어낸다(실효 스트레치 = 3/f).
//   ≤3×는 미적용 — 사용자가 청감 확정한 소리를 바꾸지 않는다.

import { endsWithEllipsis } from '../../lib/pacing';

export const SHERPA_QUALITY_MAX = 3.2; // 품질 무손상 임계(시스템 음성 전환 옵션의 기준점)
const SONIC_FIRST_MAX = 3.0; // 스트레치 단독 온전 상한
const MODEL_MAX = 3.0; // 모델 speed ≥4.0 = 전 구간 무음(실측) — 하드 경계
const PLAYBACK_HARD_MAX = 10.0; // expo-audio 패치(coerceIn 상한)와 일치

// 모델이 분담할 배수. 저속(≤1×)은 모델 전담, 스트레치 온전 구간(≤3×)은 모델 개입 금지,
// 그 초과분만 모델이 흡수한다.
export function sherpaModelSpeed(rate?: number): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r <= 1) return Math.max(0.5, r);
  if (r <= SONIC_FIRST_MAX) return 1;
  return Math.min(MODEL_MAX, r / SONIC_FIRST_MAX);
}

// 짧은 문장 템포 평준화(v1.24.0). 모델은 짧은 입력을 눈에 띄게 빠르게 읽는다(실측
// 2026-07-19: 평문 8.0±0.6 syl/s vs 장문 5.9~6.6 — 긴 문장 뒤 짧은 문장에서 "갑자기
// 빨라짐" 체감의 진범). 음절 수 기준으로 소폭 늦춰(≤12음절 0.88, 35음절+ 1.0 선형)
// 문장 간 템포를 고르게 한다. 실측: 0.88 → 8.45→7.51 syl/s.
// ⚠️ v1.26.1: 적용처가 합성 speed → "재생 스트레치"로 이동(sherpaPaceComp). 모델 speed 는
// F0(음높이)를 함께 바꾼다는 실측(0.90 → +10Hz/+5%, tone_probe EXP2 2026-07-20) — 짧은
// 문장마다 톤이 붕 뜨는 "톤 깨짐"의 원인이었다. 재생 스트레치는 피치 보존이라 페이스만
// 변한다. 텍스트의 순수 함수인 건 동일(캐시 파일과 자동 정합 — 이제 파일에 굽지도 않는다).
const TEMPO_FULL_SYL = 35;
const TEMPO_SHORT_SYL = 12;
const TEMPO_MIN_COMP = 0.88;
export function sherpaTempoComp(text: string): number {
  let syl = 0;
  for (const c of text) if (c >= '가' && c <= '힣') syl++;
  if (syl >= TEMPO_FULL_SYL) return 1;
  const t = Math.max(0, syl - TEMPO_SHORT_SYL) / (TEMPO_FULL_SYL - TEMPO_SHORT_SYL);
  return TEMPO_MIN_COMP + (1 - TEMPO_MIN_COMP) * t;
}

// 루바토(문장 완급 변주, v1.25.0). 사용자 발견에서 출발: 1.5× 낭독 중 모델이 장문을
// 고유하게 천천히 읽는 순간이 "오히려 사람 같다" — 그 완급을 의도된 변주로 정식화한다.
// 문장의 ~30%만(가끔이어야 사람같다) 결정론 해시로 골라 0.90~0.96 으로 늦춘다(실측
// 2026-07-20: 발화속도 −3~−7%, Whisper CER 열화 없음 — rubato_probe.py).
// ⚠️ v1.26.1: 적용처가 합성 speed → 재생 스트레치로 이동(sherpaPaceComp — tempoComp 주석의
// F0 실측 근거 동일). 원문 텍스트의 순수 함수라 같은 문장은 항상 같은 완급(재생마다
// 달라지면 "고장"으로 들린다).
// "너무 느려지지만 않으면"(사용자 조건) → 하한 0.90, tempoComp 와 곱 하한은
// SPEED_COMP_FLOOR 로 클램프(sherpaPaceComp).
const RUBATO_PORTION = 0.3;
const RUBATO_MIN = 0.9;
const RUBATO_MAX = 0.96;
// 문맥 완급(v1.26.0): 말줄임(…)으로 끝나는 문장은 주사위와 무관하게 "항상" 느긋하게 —
// 사람 낭독자는 여운 문장을 끌어 읽는다(일레븐랩스류 대형 모델이 학습으로 얻는 문맥
// 프로소디를, 우리는 구두점 단서로 규칙화). 감속 폭은 검증 구간(0.90 하한) 안에서 살짝
// 깊게 0.90~0.94 — pacing.ts 의 말줄임 여운 쉼(+250ms)과 합쳐져 하나의 관습이 된다.
const ELLIPSIS_RUBATO_MIN = 0.9;
const ELLIPSIS_RUBATO_MAX = 0.94;
// tempoComp × rubato 곱의 하한 — 실측 검증 구간(0.88 단독 −11%) 근방까지만 허용.
export const SPEED_COMP_FLOOR = 0.85;
export function sherpaRubato(text: string): number {
  // djb2 — pacing.ts 지터와 같은 계열(결정론 변주의 공용 도구).
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  const v = (h >>> 10) % 1000; // 감속 정도 주사위(선택과 다른 비트 대역)
  if (endsWithEllipsis(text)) {
    return ELLIPSIS_RUBATO_MIN + ((ELLIPSIS_RUBATO_MAX - ELLIPSIS_RUBATO_MIN) * v) / 1000;
  }
  const u = (h >>> 0) % 1000; // 선택 주사위(하위 비트)
  if (u >= RUBATO_PORTION * 1000) return 1;
  return RUBATO_MIN + ((RUBATO_MAX - RUBATO_MIN) * v) / 1000;
}

// 스마트 스피드(무음 압축) 적용 여부 — 스트레치 온전 구간(≤3×)의 확정된 소리는 건드리지
// 않고, 스트레치가 한계(3.0)에 붙는 초고배속에서만 쉼을 압축해 부담을 덜어낸다.
export function sherpaTrimEnabled(rate?: number): boolean {
  return Number.isFinite(rate as number) && (rate as number) > SONIC_FIRST_MAX;
}

// 재생 완급 인자(v1.26.1) — 템포 평준화 × 루바토를 "피치 보존 재생 스트레치"에 곱한다.
// 최종 재생속도 = sherpaPlaybackRate(rate, trim) × sherpaPaceComp(...). 합성 speed 는 이제
// 순수 sherpaModelSpeed 만(F0 부작용 근거는 sherpaTempoComp 주석) — 완급이 파일에 안
// 구워지므로 캐시 키에서 루바토 플래그도 사라진다.
// >3×(스마트 스피드)는 훑어 듣는 속도라 완급 무의미 + 압축 몫 계산과 얽히지 않게 1 고정.
// 하한: comp ≤ 1 이고 rate ≤ 1 에서도 최종 재생속도 = 1 × comp ≥ SPEED_COMP_FLOOR(0.85)
// ≥ expo-audio 하한(0.5) — 클램프 충돌 없음.
export function sherpaPaceComp(
  tempoComp: number,
  rubatoRaw: number,
  opts: { rate?: number; rubatoOn?: boolean },
): number {
  if (sherpaTrimEnabled(opts.rate)) return 1;
  const t = Number.isFinite(tempoComp) && tempoComp > 0 ? tempoComp : 1;
  const r = opts.rubatoOn && Number.isFinite(rubatoRaw) && rubatoRaw > 0 ? rubatoRaw : 1;
  // min(1): 현 도메인(t·r ≤ 1)에선 no-op — 미래에 가속 변주(>1)가 생겨도 완급이 설정
  // 배속을 넘지 않게 하는 방어선.
  return Math.max(SPEED_COMP_FLOOR, Math.min(1, t * r));
}

// 재생속도가 분담할 배수(전체 ÷ 모델 몫 ÷ 무음압축 몫). trimFactor = 압축으로 이미 번
// 배속(원본길이÷압축길이, 미압축=1). 곱 불변식: 모델 × trimFactor × 재생속도 = 설정 배속.
export function sherpaPlaybackRate(rate?: number, trimFactor: number = 1): number {
  const r = Number.isFinite(rate as number) ? (rate as number) : 1.0;
  if (r <= 1) return 1;
  const f = Number.isFinite(trimFactor) && trimFactor >= 1 ? trimFactor : 1;
  // 하한 0.5: 쉼이 극단적으로 많은 문장에서 압축만으로 목표 배속을 넘어선 경우 되레 늦춰
  // 설정 배속을 정확히 지킨다(현실적으론 f<3 이라 거의 항상 >1).
  return Math.max(0.5, Math.min(PLAYBACK_HARD_MAX, r / (sherpaModelSpeed(r) * f)));
}
