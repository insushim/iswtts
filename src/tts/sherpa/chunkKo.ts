// 장문 절 단위 분할(순수 함수) — sherpa(Supertonic) 합성 품질용.
//
// 왜: Supertonic 은 문장이 길어지면 운율이 흐트러진다(사용자 보고 2026-07-18 "문장이
// 길어지면 읽는 톤이 어색"). 쉼표 등 자연 경계에서 절 단위로 나눠 각각 합성하고
// 파형을 이어 붙이면(SherpaTtsEngine), 각 절이 짧은 입력의 안정된 운율을 얻는다.
// 이음새엔 쉼표 숨(짧은 무음)을 넣어 사람 낭독의 쉼처럼 들리게 한다.
//
// 원칙: 자연 경계(쉼표류)에서만 자른다 — 임의 위치 절단은 단어 억양을 깨서 역효과.
// 쉼표가 없는 장문은 그대로 둔다(모델 원 톤 유지가 임의 절단보다 낫다).

/** 이 길이(글자) 초과 문장만 분할 대상 — 짧은 문장은 원 톤이 이미 안정적이다. */
export const CHUNK_THRESHOLD = 60;
/** 청크 목표 상한(가능하면 이 안쪽으로). */
const TARGET_MAX = 60;
/** 이보다 짧은 조각은 이웃과 합친다(너무 잘게 끊긴 낭독 방지). */
const MIN_CHUNK = 12;
/** 청크 수 상한 — 합성 타임아웃(SYNTH_TIMEOUT_MS)이 문장당 예산이라 네이티브 왕복 수를
 *  묶는다(교차검증 지적 2026-07-18). 초과분은 마지막 청크에 흡수(품질보다 완주 우선). */
const MAX_CHUNKS = 6;

// 절 경계로 취급하는 구두점(뒤따르는 닫는 따옴표·괄호·한국식 인용부호까지 청크에 포함).
// injectBreathInline 의 삽입 위치 탐색과 공유(정규식 이중화 방지) — 전역 플래그 정규식이므로
// 사용 전 lastIndex 리셋 필수.
const CLAUSE_BREAK = /[,，、;；]['"’”」』)\]）】]*\s*/g;

/**
 * 문장에 숨을 심을 절 경계(쉼표류)가 있는가 — SherpaTtsEngine.breathApplies 판정의 반쪽.
 * 자릿수 쉼표(12,500)는 절 경계가 아니므로 제거 후 검사(교차검증 지적 2026-07-18).
 */
export function hasClauseComma(text: string): boolean {
  return /[,，、;；]/.test(text.replace(/(\d),(?=\d)/g, '$1'));
}

/** 숨을 심기엔 너무 짧은 후속 절(글자) — "하나, 둘, 셋" 열거에서 헐떡임 방지. */
const BREATH_MIN_CLAUSE = 6;

/**
 * 문장의 절 경계(쉼표류) 뒤마다 <breath> 를 심는다(SherpaTtsEngine 의 숨소리 옵션 —
 * 모델이 태그를 들숨으로 렌더, 실측 2026-07-18 태그 미발음 +0.3s, 다중 태그도 정상).
 * v1.24.0: "쉼표 자리에서 거의 항상 숨"(사용자 요청 2026-07-19) — 가운데 1회 → 전 경계.
 * 제외: 문장 끝 쉼표(뒤에 본문 없음), 숫자 사이 쉼표(1,50 비정형 — 정형 12,500 은
 * 정규화가 소거), 후속 절이 너무 짧은 경계(열거 헐떡임 방지). 경계가 없으면 원문 그대로.
 */
export function injectBreathInline(text: string): string {
  const ends: number[] = [];
  // matchAll 은 정규식을 내부 복제해 lastIndex 를 공유하지 않는다(전역 정규식 오염 원천 차단).
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    const end = m.index + m[0].length;
    if (end >= text.length) continue;
    if (/\d/.test(text[m.index - 1] ?? '') && /\d/.test(text[end])) continue;
    ends.push(end);
  }
  if (!ends.length) return text;
  // 다음 경계(또는 문장 끝)까지의 본문 길이가 임계 미만인 경계는 건너뛴다.
  const eligible = ends.filter((at, i) => {
    const until = i + 1 < ends.length ? ends[i + 1] : text.length;
    return until - at >= BREATH_MIN_CLAUSE;
  });
  if (!eligible.length) return text;
  let out = '';
  let pos = 0;
  for (const at of eligible) {
    out += `${text.slice(pos, at)}<breath> `;
    pos = at;
  }
  return out + text.slice(pos);
}

/**
 * 문장을 합성 청크로 분할. 쉼표류 경계에서만 자르고, 짧은 조각은 이웃과 합친다.
 * 경계 구두점(쉼표)은 왼쪽 청크에 남긴다 — 모델이 쉼표를 보고 이어지는 억양을 만든다.
 * 분할 불가(짧은 문장·쉼표 없음)면 [원문] 그대로.
 */
export function chunkForSynthesis(text: string): string[] {
  if (text.length <= CHUNK_THRESHOLD) return [text];

  // 쉼표 경계로 1차 조각내기(경계 문자는 왼쪽 조각 끝에 포함).
  const parts: string[] = [];
  let pos = 0;
  CLAUSE_BREAK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_BREAK.exec(text))) {
    const end = m.index + m[0].length;
    parts.push(text.slice(pos, end));
    pos = end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  if (parts.length <= 1) return [text];

  // 그리디 병합: 조각을 순서대로 붙이되, 청크가 MIN 을 넘겼고 다음 조각을 붙이면 TARGET 을
  // 초과할 때 끊는다. (조각 자체가 TARGET 보다 길면 그대로 한 청크 — 임의 절단 금지.)
  const chunks: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (!cur) {
      cur = part;
      continue;
    }
    if (cur.trim().length < MIN_CHUNK || cur.length + part.length <= TARGET_MAX) {
      cur += part;
    } else {
      chunks.push(cur);
      cur = part;
    }
  }
  if (cur) {
    // 꼬리 조각이 너무 짧으면 마지막 청크에 흡수("…했다." 한 조각짜리 낭독 방지).
    if (cur.trim().length < MIN_CHUNK && chunks.length) {
      chunks[chunks.length - 1] += cur;
    } else {
      chunks.push(cur);
    }
  }
  // 청크 수 상한 — 초과분은 마지막 청크에 합친다(네이티브 왕복 수 = 타임아웃 예산).
  if (chunks.length > MAX_CHUNKS) {
    const merged = chunks.slice(MAX_CHUNKS - 1).join('');
    chunks.length = MAX_CHUNKS - 1;
    chunks.push(merged);
  }
  return chunks.length > 1 ? chunks : [text];
}
