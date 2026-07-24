// 고정폭 하드랩 복원(순수 함수) — "단어 중간 가짜 공백"을 만들지 않고 문단을 재조립한다.
//
// 왜: 옛 소설 txt 는 대부분 **문자수 기준**으로 줄이 접혀 있다(어절 경계를 안 본다). 그래서
// 원문 "자신도"가 파일에서는 "…자\n신도 모르는…"으로 끊겨 있고, 지금까지 우리는 문단 안 줄을
// 무조건 공백으로 이어(v1.25.2) "자 신도"라는 **원문에 없던 공백**을 만들어 저장했다.
// 그 공백은 (a) 화면에 그대로 보이고 (b) 합성 모델이 두 어절로 끊어 읽어 발음을 망가뜨린다 —
// "앉아 있다"가 "앉 아 있다"가 되면 연음이 깨져 "안 아 있다"로 들린다(사용자 보고 2026-07-24,
// 스크린샷의 "자 신도 모르는"·"곧 무리의 명 령체계에"가 그 증거).
//
// 어떻게: 이음매마다 "붙일까 띄울까"를 세 신호로 판정한다.
//   R0 줄 끝의 공백(파일이 랩 지점의 공백을 보존한 경우) = 확실한 어절 경계 → 공백.
//   R1 다음 줄이 닫는 구두점(., ! ? … , 」 등)으로 시작 = 공백이 올 수 없는 자리 → 붙인다.
//   R2 **문서 내부 어휘**: 이어붙인 형태가 이 문서 어딘가에(줄 중간 = 랩에 안 잘린 자리)
//      실제로 등장하면 원래 한 단어였다는 증거 → 붙인다.
// 실측(초한지 합본 215k자, 문자랩 W=40/80 시뮬레이션 4135/1734 이음매):
//   병합 정밀도 99.7%, 재현율 75~77%. 이미 어절 단위로 접힌 정상 파일(대조군)에서는 오병합
//   0.5%(대부분 "한 번"→"한번" 같은 무해한 붙여쓰기). 현행(항상 공백)은 단어중간 이음매
//   2043건을 100% 가짜 공백으로 남긴다.
// 1음절 조사("…입안으|로")까지 붙이는 규칙(R3)도 시험했으나 정밀도가 99.7→99.2%로 떨어지고
// 오병합이 "칼을|든"·"죽은|지"처럼 **정상 띄어쓰기를 깨는** 쪽이라 채택하지 않았다.

/** 어휘 키 — 앞뒤 비단어 문자(따옴표·구두점)를 벗긴 형태. */
export function tokenCore(t: string): string {
  return t.replace(/^[^가-힣A-Za-z0-9]+/, '').replace(/[^가-힣A-Za-z0-9]+$/, '');
}

// 앞에 공백이 올 수 없는 문자(닫는 구두점·닫는 따옴표). ASCII " ' 는 여닫이가 같아 제외.
const CLOSE_PUNCT = /^[.!?…。！？,，、:;”’」』)\]]/;
// 줄이 "경계"로 끝났는가 — 닫는 따옴표·괄호는 벗기고 그 앞의 구두점으로 판정한다.
// ⚠️ "닫는 따옴표로 끝나면 무조건 경계"는 틀렸다(교차검증 codex): 『"무공"\n을』은 원래
// 『"무공"을』이므로 붙여야 한다. 종결·쉼표류가 실제로 있을 때만 경계로 본다.
const TAIL_QUOTES = /["'”’」』)\]]+$/;
const TAIL_PUNCT = /[.!?…。！？,，、:;·]$/;
const OPEN_PUNCT = /^["'“‘「『(\[]/;
const HANGUL = /[가-힣]/;

/** 이 토큰이 "경계"로 끝나는가 — 꼬리 따옴표·괄호를 벗긴 뒤 구두점으로 판정. */
function endsAtBoundary(a: string): boolean {
  return TAIL_PUNCT.test(a.replace(TAIL_QUOTES, ''));
}

export type WrapVocab = Map<string, number>;

/** 문서 내부 어휘 — **줄의 첫/끝 토큰은 제외**한다(랩에 잘렸을 수 있는 자리). */
export function buildWrapVocab(lines: string[]): WrapVocab {
  const v: WrapVocab = new Map();
  for (const line of lines) {
    const toks = line.split(/\s+/).filter(Boolean);
    for (let i = 1; i < toks.length - 1; i++) {
      const k = tokenCore(toks[i]);
      if (k.length >= 2) v.set(k, (v.get(k) || 0) + 1);
    }
  }
  return v;
}

/** 이 문서가 문자수 기준으로 접혔는가 — 이음매를 가진 줄(문단의 마지막 줄 제외)의 길이가
 *  한 폭에 몰려 있으면 참. 어절 단위로 접힌 파일은 줄 길이가 들쭉날쭉해 거짓이 된다.
 *  판정은 **문서 전체**로 한다(2~3줄짜리 문단별 판정은 표본이 없어 오판 — 교차검증 codex).
 *  자동 적용의 "충분조건"이지 필요조건이 아니다 — 애매하면 종전 동작(전부 공백)으로 남긴다. */
export function looksCharWrapped(joinLines: string[]): boolean {
  const lens = joinLines.map((l) => l.length).filter((n) => n > 0);
  if (lens.length < 12) return false; // 표본 부족(교차검증 codex: 8→12)
  const w = Math.max(...lens);
  if (w > 200 || w < 20) return false; // 랩이 아니라 원래 긴 줄 / 표·목록처럼 짧은 줄
  const full = joinLines.filter((l) => l.length >= w - 1);
  if (full.length < 8) return false;
  if (full.length / lens.length < 0.7) return false;
  // "한 줄 = 한 문장"으로 개행한 파일 방어: 폭이 꽉 찬 줄이 종결부호로 끝나는 일은 문자수
  // 랩에서 드물다. 4줄에 1줄 이상이 그렇다면 문자수 랩이라고 확신할 수 없다(codex 지적).
  const punctEnd = full.filter((l) => /[.!?…。！？"'”’」』]$/.test(l)).length;
  return punctEnd / full.length < 0.25;
}

/** 이 이음매를 공백 없이 붙여야 하는가(R1·R2). R0(줄 끝 공백)은 호출부가 먼저 판정한다. */
export function mergeAcrossWrap(a: string, b: string, vocab: WrapVocab): boolean {
  if (!a || !b) return false;
  // 한글이 없는 토큰(장식선 ═══, 화살표, 한자 병기 등)은 어휘 판정이 무의미 — 닫는 구두점만.
  if (!HANGUL.test(a) || !HANGUL.test(b)) return CLOSE_PUNCT.test(b) && HANGUL.test(a);
  if (CLOSE_PUNCT.test(b)) return true; // R1
  if (endsAtBoundary(a) || OPEN_PUNCT.test(b)) return false;
  const merged = tokenCore(a + b);
  const c = vocab.get(merged) || 0;
  if (c >= 1) {
    // 두 쪽 다 흔한 어절이면 원래 띄어져 있었을 가능성이 높다(붙인 형태가 더 흔할 때만 병합).
    const ca = vocab.get(tokenCore(a)) || 0;
    const cb = vocab.get(tokenCore(b)) || 0;
    if (ca === 0 || cb === 0 || c >= Math.min(ca, cb)) return true; // R2
  }
  return morphologicalContinuation(tokenCore(a), tokenCore(b)); // R3
}

// R3 — 받침 있는 1음절 + 모음으로 시작하는 다음 어절(앉|아, 읽|어, 값|이). 한국어에서 받침
// 1음절 어간이 홀로 어절이 되는 일은 거의 없고, 모음 초성 어절은 조사·어미인 경우가 많다
// (교차검증 Gemini 제안). 실측(초한지 코퍼스 시뮬레이션): 재현율 +0.9%p, 정밀도 −0.06%p
// (오병합 3→4건/4135). 사용자가 보고한 "앉 아 → 안 아" 계열을 어휘에 없더라도 잡는다.
const VOWEL_INITIAL = /^[아어여오우으이은는을를에]/;
function morphologicalContinuation(a: string, b: string): boolean {
  if (a.length !== 1 || !b) return false;
  const code = a.charCodeAt(0) - 0xac00;
  if (code < 0 || code >= 11172 || code % 28 === 0) return false; // 받침 없는 음절 제외
  return VOWEL_INITIAL.test(b);
}

/**
 * 한 문단의 줄들을 하나의 흐름으로 잇는다.
 * @param lines      trim 된 줄들
 * @param hadTrailingSpace lines[i] 가 원본에서 공백으로 끝났는가(R0) — 없으면 전부 false
 * @param vocab      buildWrapVocab 결과. null 이면 종전대로 전부 공백으로 잇는다.
 */
export function joinWrappedLines(
  lines: string[],
  hadTrailingSpace: boolean[],
  vocab: WrapVocab | null,
): string {
  if (!lines.length) return '';
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prevTokens = out.split(/\s+/);
    const a = prevTokens[prevTokens.length - 1] || '';
    const b = lines[i].split(/\s+/)[0] || '';
    const merge =
      !!vocab && !hadTrailingSpace[i - 1] && mergeAcrossWrap(a, b, vocab);
    out += merge ? lines[i] : ' ' + lines[i];
  }
  return out;
}

// ── 이미 저장된 문장의 사후 복원(마이그레이션) ───────────────────────────
// 저장본에는 줄 정보가 없다(이미 공백으로 이어 붙인 상태). 그래서 "어느 공백이 가짜인가"를
// 문서 전체 통계로 되짚는다: 붙인 형태가 문서에 2회 이상 나오고, 그 자리에 띄어 쓴 짝
// (바이그램)보다 더 흔하면 가짜 공백으로 본다.
// 실측(같은 코퍼스, 저장본 재현): 정밀도 96.7% / 재현율 70%(W=40). 남는 오병합은
// "위에 서"→"위에서", "그 들을"→"그들을" 처럼 붙여도 소리가 크게 상하지 않는 쪽이다.
// 추가 시점 복원(위 R0~R2, 99.7%)보다 약하므로 **이미 추가된 책 구제 전용**이다.

export type RepairIndex = { uni: Map<string, number>; bi: Map<string, number> };

const REPAIR_MIN_COUNT = 2;

export function buildRepairIndex(sentences: string[]): RepairIndex {
  const uni = new Map<string, number>();
  const bi = new Map<string, number>();
  for (const s of sentences) {
    const t = s.split(/\s+/).filter(Boolean).map(tokenCore);
    for (const k of t) if (k.length >= 2) uni.set(k, (uni.get(k) || 0) + 1);
    for (let i = 0; i < t.length - 1; i++) {
      const k = `${t[i]} ${t[i + 1]}`;
      bi.set(k, (bi.get(k) || 0) + 1);
    }
  }
  return { uni, bi };
}

function repairMerge(a: string, b: string, idx: RepairIndex): boolean {
  if (!HANGUL.test(a) || !HANGUL.test(b)) return CLOSE_PUNCT.test(b) && HANGUL.test(a);
  if (CLOSE_PUNCT.test(b)) return true;
  if (TAIL_PUNCT.test(a) || OPEN_PUNCT.test(b)) return false;
  const merged = tokenCore(a + b);
  const c = idx.uni.get(merged) || 0;
  if (c < REPAIR_MIN_COUNT) return false;
  return c > (idx.bi.get(`${tokenCore(a)} ${tokenCore(b)}`) || 0);
}

/** 저장된 문장 하나에서 가짜 공백을 복원한다(문장 수·순서는 불변 — 읽던 위치 보존). */
export function repairFakeSpaces(sentence: string, idx: RepairIndex): string {
  const t = sentence.split(/\s+/).filter(Boolean);
  if (t.length < 2) return sentence;
  let out = t[0];
  // 판정의 왼쪽은 "직전 원본 토큰"이 아니라 **지금까지 이어붙인 마지막 어절**이다
  // (여러 번 잘린 "생 각 합니 다" 가 단계적으로 "생각"→"생각합니"→"생각합니다"로 붙는다).
  let last = t[0];
  for (let i = 1; i < t.length; i++) {
    if (repairMerge(last, t[i], idx)) {
      out += t[i];
      last += t[i];
    } else {
      out += ' ' + t[i];
      last = t[i];
    }
  }
  return out;
}
