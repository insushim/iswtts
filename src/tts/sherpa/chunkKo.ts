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
// 전역 플래그 정규식이므로 사용 전 lastIndex 리셋 필수.
// (v1.26.0: `<breath>` 태그 인라인 주입(injectBreathInline)은 "이 팩이 태그를 지원하지
//  않음" 대조군 실측으로 폐기 — 들숨은 절 이음새에 합성 파형으로 삽입한다. breathWav.ts.)
const CLAUSE_BREAK = /[,，、;；]['"’”」』)\]）】]*\s*/g;

/**
 * 문장에 숨을 심을 절 경계(쉼표류)가 있는가 — SherpaTtsEngine.breathApplies 판정의 반쪽.
 * 자릿수 쉼표(12,500)는 절 경계가 아니므로 제거 후 검사(교차검증 지적 2026-07-18).
 */
export function hasClauseComma(text: string): boolean {
  return /[,，、;；]/.test(text.replace(/(\d),(?=\d)/g, '$1'));
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

  // 균등 분배(v1.27.3). 종전 그리디는 앞 청크를 TARGET_MAX(60)까지 채우고 나머지를 뒤로
  // 넘겨, 한 문장 안에서 "앞은 길고 뒤는 짧은" 청크가 생겼다. 이 모델은 **입력이 짧을수록
  // 빨리 읽는다** — 실측 2026-07-24(chunktempo_probe): 55자 5.87 syl/s vs 7자 7.04 syl/s
  // (+20%). 그래서 같은 문장 안에서 앞이 느리고 뒤가 빨라지는 가속감이 생겼다(사용자 보고
  // "문장 시작이 약간 느리게 읽힌다"의 유력 원인). 청크 길이를 최대한 고르게 나누면 그
  // 편차가 줄어든다. 경계는 여전히 절(쉼표) 자리뿐 — 임의 절단은 하지 않는다.
  const lens = parts.map((p) => p.length);
  const total = lens.reduce((a, b) => a + b, 0);
  // 청크 수: 목표 상한을 넘지 않는 최소 개수. 단 조각당 MIN_CHUNK 는 확보하고 상한도 지킨다.
  const k = Math.max(
    1,
    Math.min(parts.length, MAX_CHUNKS, Math.floor(total / MIN_CHUNK), Math.ceil(total / TARGET_MAX)),
  );
  const chunks = k <= 1 ? [text] : balancedGroups(parts, lens, k);
  return chunks.length > 1 ? chunks : [text];
}

/** 연속 조각들을 k 개 그룹으로 — 각 그룹 길이가 평균(total/k)에서 벗어난 정도의 제곱합을
 *  최소화한다(작은 DP: 조각 수 × k 라 비용 무시 가능). 순서·내용은 보존. */
function balancedGroups(parts: string[], lens: number[], k: number): string[] {
  const n = parts.length;
  const pre = [0];
  for (let i = 0; i < n; i++) pre.push(pre[i] + lens[i]);
  const target = pre[n] / k;
  const cost = (i: number, j: number) => (pre[j] - pre[i] - target) ** 2; // [i, j)
  const INF = Infinity;
  // dp[c][i] = 앞의 i 조각을 c 그룹으로 나눈 최소 비용, cut[c][i] = 마지막 그룹 시작점
  const dp: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
  dp[0][0] = 0;
  for (let c = 1; c <= k; c++) {
    for (let i = c; i <= n; i++) {
      for (let j = c - 1; j < i; j++) {
        const v = dp[c - 1][j] + cost(j, i);
        if (v < dp[c][i]) {
          dp[c][i] = v;
          cut[c][i] = j;
        }
      }
    }
  }
  const out: string[] = [];
  let end = n;
  for (let c = k; c >= 1; c--) {
    const start = cut[c][end];
    out.unshift(parts.slice(start, end).join(''));
    end = start;
  }
  return out;
}

// 절 이음새 쉼 지터(v1.25.0, 교차검증 제안 채택). 문장 "간" 쉼(pacing.ts)엔 문맥 지터가
// 있는데 장문 내부의 절 경계 쉼만 240ms 고정이라 쉼표마다 기계적으로 똑같이 쉬었다 —
// 다음 절 텍스트의 djb2 해시로 0~45ms 를 결정론 감산해 195~240ms 로 변주한다.
// 하향 전용인 이유: 총 이음새 쉼(꼬리 80 + 삽입 + 머리 40)이 문장 간 쉼(360ms)을 넘지
// 않아야 한다는 엔진 캡(INTER_CHUNK_PAUSE_MS 주석)을 위로는 못 넘기 때문. 텍스트의 순수
// 함수라 같은 문장은 항상 같은 리듬(캐시 키=오디오 정합 자동 유지).
const CHUNK_JITTER_MAX_MS = 45;
export function chunkPauseJitterMs(chunkText: string): number {
  let h = 5381;
  for (let i = 0; i < chunkText.length; i++) h = ((h * 33) ^ chunkText.charCodeAt(i)) >>> 0;
  return h % (CHUNK_JITTER_MAX_MS + 1);
}
