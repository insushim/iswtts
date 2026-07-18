// 낭독 페이스 자연화(순수 함수) — 문장 사이 쉼을 사람 낭독자처럼 "문맥"에 따라 변주한다.
//
// 왜: 합성 파일에 굽는 기본 문장 간 쉼(TRAIL 320 + LEAD 40 = 360ms)은 모든 문장에서
// 정확히 동일해 메트로놈처럼 규칙적이다. 사람 낭독자는 문단이 바뀔 때 길게, 말줄임 뒤엔
// 여운 있게, 대화문 앞뒤엔 잠깐의 beat 를 두고, 긴 문장 뒤엔 숨을 회복한다(v1.23.0).
//
// 어디서: 재생 단계(player.ts 의 문장 자동진행)에서 다음 문장 발화 전 지연으로만 적용 —
// 합성·캐시를 전혀 건드리지 않아 음질 리스크 0, 파일 캐시도 그대로 유효하다.
// 수동 넘김(다음/이전 버튼·seek)에는 적용하지 않는다(사용자는 즉시 반응을 원한다).

/** 추가 쉼 상한(1× 기준, ms) — 기본 360ms 위에 얹힌다. 지터는 상한 적용 뒤에 더해져
 *  극적 조합(문단+말줄임+대화)에서도 변주가 살아 있다(최종 최대 700+50). 반환값은 배속으로
 *  나눈 뒤라 0.5× 에선 이보다 커질 수 있다(느린 청취일수록 여운도 긴 게 자연스럽다). */
const MAX_EXTRA_MS = 700;
/** 이보다 짧은 추가 쉼은 타이머를 걸 가치가 없다(즉시 진행) — player.ts 가 쓴다. */
export const MIN_TIMER_MS = 20;
/** 문단 전환: 장면이 바뀌는 호흡. */
const PARAGRAPH_MS = 350;
/** 말줄임(…) 뒤: 여운. */
const ELLIPSIS_MS = 250;
/** 물음/느낌표 뒤: 살짝 띄운다. */
const EXCLAIM_MS = 120;
/** 대화문 경계(닫는 인용부호로 끝나거나 여는 인용부호로 시작): 화자 전환의 beat. */
const DIALOGUE_MS = 150;
/** 긴 문장 뒤 숨 회복(글자 수 임계별). */
const LONG_SENT_MS = 150;
const MID_SENT_MS = 80;
/** 문장별 미세 변주 폭(±ms) — 결정적(텍스트 해시)이라 같은 문장 쌍은 항상 같은 쉼. */
const JITTER_MS = 50;

// 문장 꼬리의 닫는 인용부호·괄호(구두점 판정 시 벗겨낸다).
const TRAIL_QUOTES = /["'”’」』)\]）】]+$/;
const ENDS_DIALOGUE = /["'”’」』]$/;
const STARTS_DIALOGUE = /^["'“‘「『]/;
const ELLIPSIS_END = /(?:…|⋯|‥|\.{3})$/;

// djb2 문자열 해시 — 암호학적 품질 불필요, 결정성만 필요(캐시·재현성).
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 문장 자동진행 시 다음 문장 발화 전에 둘 "추가" 쉼(ms).
 * - 배속 비례 축소(빠르게 들을수록 쉼도 짧게), >3×(스마트 스피드)는 0(훑는 속도의 밀도 유지).
 * - 결정적: 같은 (prev, next, 문단 여부, 배속)이면 항상 같은 값.
 */
export function sentenceGapMs(
  prev: string,
  next: string,
  opts: { paragraphBreak: boolean; rate: number },
): number {
  const rate = opts.rate > 0 ? opts.rate : 1;
  if (rate > 3) return 0;

  let ms = 0;
  if (opts.paragraphBreak) ms += PARAGRAPH_MS;

  const tail = prev.trim().replace(TRAIL_QUOTES, '');
  if (ELLIPSIS_END.test(tail)) ms += ELLIPSIS_MS;
  else if (/[!?！？]$/.test(tail)) ms += EXCLAIM_MS;

  if (ENDS_DIALOGUE.test(prev.trim()) || STARTS_DIALOGUE.test(next.trim())) ms += DIALOGUE_MS;

  if (prev.length >= 80) ms += LONG_SENT_MS;
  else if (prev.length >= 50) ms += MID_SENT_MS;

  // 미세 변주: −JITTER..+JITTER. 특징이 하나도 없는 평문 사이도 0~+50ms 로 미세하게 흔들려
  // 메트로놈 규칙성이 사라진다(음수 합은 0 으로 클램프).
  // 상한 클램프 "뒤"에 더하는 이유: 극적 조합(문단+말줄임+대화 = 750)이 상한에서 잘리면
  // 지터까지 흡수돼 정확히 그 전환들만 다시 규칙적이 된다(교차검증 지적 2026-07-18) —
  // 최종 최대 700+50.
  const jitter = (hash(prev + '\u0000' + next) % (JITTER_MS * 2 + 1)) - JITTER_MS;

  return Math.round(Math.max(0, Math.min(MAX_EXTRA_MS, ms) + jitter) / rate);
}
