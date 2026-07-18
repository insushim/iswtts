// 한국어 발화 정규화(순수 함수) — sherpa(Supertonic) 합성 "입력"만 다듬는다.
//
// 왜: Supertonic 은 숫자·기호를 신뢰성 있게 못 읽는다(실측 2026-07-18, Whisper 채록):
// "12,500원"→"칠천 오번", "85%"→"버서쇠", "3개"→발음 붕괴, 괄호 한자 "沙果"→중국어
// 발음(사궈). 발음이 확실한 한글로 미리 풀어 준다.
//
// ⚠️ 하이라이트 계약: 이 변환은 "말소리"에만 쓰이고, 단어 하이라이트 경계(align.ts)는
// 원문 텍스트로 계산한다(SherpaTtsEngine.doSynthesize). 숫자를 풀면 발화가 원문 글자수
// 비례보다 길어져 그 구간 하이라이트가 다소 어긋날 수 있지만(문장 끝에서 자기 보정),
// "숫자를 아예 잘못 읽는" 것보다 훨씬 낫다. 시스템·Edge 엔진은 자체 정규화가 온전하므로
// 이 모듈을 쓰지 않는다.

// ── 한자어(사노) 수 읽기 ────────────────────────────────
const SINO_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const SMALL_UNITS = ['', '십', '백', '천'];
const BIG_UNITS = ['', '만', '억', '조', '경'];

// 0~9999 를 한자어로(선행 "일" 생략: 1948 → 천구백사십팔).
function sinoUnder10000(n: number): string {
  if (n === 0) return '';
  let out = '';
  let rest = n;
  for (let p = 3; p >= 0; p--) {
    const unit = 10 ** p;
    const d = Math.floor(rest / unit);
    rest %= unit;
    if (d === 0) continue;
    out += (d === 1 && p > 0 ? '' : SINO_DIGITS[d]) + SMALL_UNITS[p];
  }
  return out;
}

/** 정수 문자열(쉼표 없음) → 한자어 읽기. "0"은 "영". 20자리 초과는 자릿수 낭독으로 폴백. */
export function readSino(digits: string): string {
  const s = digits.replace(/^0+(?=\d)/, '');
  if (s === '0' || s === '') return '영';
  if (s.length > 20) return s.split('').map((d) => (d === '0' ? '공' : SINO_DIGITS[Number(d)])).join('');
  const groups: number[] = [];
  for (let end = s.length; end > 0; end -= 4) {
    groups.unshift(Number(s.slice(Math.max(0, end - 4), end)));
  }
  let out = '';
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g === 0) continue;
    const unit = BIG_UNITS[groups.length - 1 - i];
    // "만" 앞의 1 생략(10000 → "만")은 수가 만 단위로 "시작"할 때만 — 억 아래 중간 자리로
    // 오는 만은 "일"을 붙인다(1억 1만 → "일억일만", 교차검증 발견 2026-07-18: 구현이
    // 위치 무관 생략이라 "일억만"으로 읽혔음). "일억"처럼 억 이상은 관례상 항상 "일".
    const body = g === 1 && unit === '만' && i === 0 ? '' : sinoUnder10000(g);
    out += body + unit;
  }
  return out;
}

// ── 고유어 수 읽기(수관형사형: 한/두/세…) — 1~99 ────────────
const NATIVE_ONES = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
const NATIVE_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];

/** 1~99 를 고유어 수관형사로(단위명사 앞 꼴: 스물+한 → "스물한", 딱 20은 "스무"). */
export function readNative(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (n === 20) return '스무';
  return NATIVE_TENS[tens] + NATIVE_ONES[ones];
}

// ── 단위(수분류사) 분류 ─────────────────────────────────
// 고유어 수사와 어울리는 단위(세 개·두 명·열 살…). 100 이상 값은 한자어로 폴백.
const NATIVE_COUNTERS = new Set([
  '개', '명', '살', '마리', '번', '병', '잔', '채', '척', '켤레', '그루', '송이',
  '대', '벌', '권', '장', '곡', '군데', '가지', '마디', '시간', '사람',
]);
// 첫 글자가 고유어 단위와 같지만 실제로는 한자어로 읽는 2자 복합("3개월"=삼개월, "3번지"=삼번지).
// 고유어 판정(1자) 전에 이 목록을 먼저 확인한다.
const SINO_COMPOUND_2 = new Set(['개월', '개국', '개소', '번지']);
// 첫 글자가 단위(월·시)처럼 보이지만 단위가 아닌 일반 단어의 머리("6월드컵"→유월드컵 오탐,
// "3시대"→세시대 오탐 방지 — 교차검증 발견 2026-07-18). 매칭되면 그냥 한자어 수로 읽는다.
const NOT_COUNTER_2 = new Set(['월드', '시대']);
// 한자어 수사와 어울리는 단위(삼십 분·오 년·이 층…). 목록에 없어도 기본은 한자어.
// (여기 명시는 가독 목적 — 분류 로직은 NATIVE_COUNTERS 만 본다.)
// 년 월 일 분 초 원 도 층 호 번지 학년 페이지 퍼센트 미터 킬로 인분 회 세 …

// 시각의 "시"는 고유어(세 시), 기간·각도의 "분·초"는 한자어(삼십 분) — 한국어 관례.
const HOUR_COUNTER = '시';

// 단위 후보로 볼 수 있는, 숫자 바로 뒤 한글 연속(최대 2자에서 매칭 시도, 긴 것 우선).
const COUNTER_MAX = 2;

function readMonth(n: number): string | null {
  // 6월=유월, 10월=시월(수의 두음 탈락) — 한국어 고정 관례.
  if (n === 6) return '유';
  if (n === 10) return '시';
  return null;
}

// ── 본체 ───────────────────────────────────────────────
// 괄호(반각·전각) 안이 한자(+숫자·구분자)로 이루어진 주석: "사과(沙果)"·"(2026年)".
// 한자가 1자 이상 있어야 하고 한글은 없어야 한다. 통째로 제거 — 남기면 다국어 모델이
// 중국어로 읽는다(실측: 沙果→"사궈").
const HANJA_PAREN = /[（(](?=[^)）]*[㐀-䶿一-鿿豈-﫿])[0-9\s·:,、‧㐀-䶿一-鿿豈-﫿]+[)）]/g;

// 전화번호류(하이픈 연결 숫자열): 자릿수 낭독("공일공 일이삼사 오육칠팔") — 기수 읽기를
// 적용하면 선행 0 이 사라지고("010"→"십") 하이픈이 오독된다(교차검증 발견 2026-07-18).
const HYPHEN_DIGITS = /\d+(?:-\d+)+/g;

// 숫자 토큰: 쉼표 자릿수 구분(1,234,567) 허용 + 소수부 허용.
const NUM_TOKEN = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;

/** 자릿수 낭독("일사"·"공일공"). 0은 "공". */
function readDigits(digits: string): string {
  return digits.split('').map((d) => (d === '0' ? '공' : SINO_DIGITS[Number(d)])).join('');
}

/**
 * sherpa 합성용 한국어 발화 정규화.
 * ① 괄호 한자 주석 제거 ② 숫자를 단위에 맞는 한글 읽기로(고유어/한자어), 소수·%·쉼표수 지원.
 * 결정적·멱등(같은 입력 → 같은 출력) — 캐시 키는 원문이므로 결과가 흔들리면 안 된다.
 */
export function normalizeForSpeech(text: string): string {
  // ① 괄호 한자 주석 제거(발음 안내용 병기 — 읽지 않는 것이 자연스럽다).
  let out = text.replace(HANJA_PAREN, '');

  // ①-보강: 중첩 괄호("(漢(字))")는 안쪽부터 벗겨지므로 한 번 더(2패스면 실사용 충분).
  // (g 플래그 정규식에 test() 를 섞으면 lastIndex 가 오염되므로 무조건 재적용.)
  out = out.replace(HANJA_PAREN, '');

  // ② 하이픈 숫자열: 두 그룹 다 1~2자리(선행 0 없음)면 범위("3-5번" → 삼에서 오번)로,
  //    그 외(전화번호·코드)는 그룹별 자릿수 낭독("공일공 일이삼사 오육칠팔").
  out = out.replace(HYPHEN_DIGITS, (m) => {
    const groups = m.split('-');
    if (groups.length === 2 && groups.every((g) => g.length <= 2 && !/^0\d/.test(g))) {
      return `${groups[0]}에서 ${groups[1]}`; // 숫자는 남겨 아래 단위 규칙을 그대로 태운다
    }
    return groups.map(readDigits).join(' ');
  });

  // ③ 숫자 범위 "1950~60"·"1~2": 물결을 "에서"로 풀어 각 수가 아래 규칙을 그대로 탄다.
  out = out.replace(/(\d)\s*~\s*(?=\d)/g, '$1에서 ');

  // ④ 숫자 읽기.
  out = out.replace(NUM_TOKEN, (match, intRaw: string, fracRaw: string | undefined, offset: number, whole: string) => {
    const digits = intRaw.replace(/,/g, '');
    const intVal = Number(digits);

    // 소수: 항상 한자어 + "점" + 자릿수 낭독(36.5 → 삼십육 점 오). 뒤 단위는 그대로 둔다.
    // (선행 0 검사보다 먼저 — "0.5도"의 정수부 0 이 자릿수 분기로 새면 소수부가 유실된다,
    //  교차검증 발견 2026-07-18.)
    if (fracRaw) {
      return `${readSino(digits)} 점 ${readDigits(fracRaw.slice(1))}`;
    }

    // 선행 0(코드·국번 등 비기수 표기: "007")은 자릿수 낭독이 자연스럽다.
    if (/^0\d/.test(digits)) return readDigits(digits);

    const after = whole.slice(offset + match.length);
    const before = whole.slice(0, offset);

    // % 는 여기서 함께 치환하지 않고(토큰 밖) 아래 ③ 에서 처리 — 숫자만 한자어로.
    // "제2차"처럼 "제-" 서수 접두는 무조건 한자어. ("언제 2시"의 '제' 오탐 방지: 앞이
    // 한글이 아닌 위치의 독립 '제'만 서수로 본다.)
    const ordinal = /(^|[^가-힣])제\s?$/.test(before);

    // 숫자 바로 뒤 한글 단위 탐색(긴 것 우선). 공백 하나까지는 허용("3 개").
    if (!ordinal) {
      const m = after.match(/^ ?([가-힣]{1,2})/);
      if (m) {
        const counterRun = m[1];
        // 고유어 1자 단위로 시작하지만 실제론 한자어인 2자 복합(개월·번지 등)을 먼저 컷.
        if (SINO_COMPOUND_2.has(counterRun)) return readSino(digits);
        // 단위처럼 보이는 일반 단어 머리(월드·시대 등)도 컷 — 그냥 한자어 수.
        if (NOT_COUNTER_2.has(counterRun)) return readSino(digits);
        for (let len = Math.min(COUNTER_MAX, counterRun.length); len >= 1; len--) {
          const counter = counterRun.slice(0, len);
          if (counter === '월') {
            const month = readMonth(intVal);
            if (month) return month;
            return readSino(digits);
          }
          if (counter === HOUR_COUNTER && counterRun.slice(0, 2) !== '시간') {
            // 시각(1~12시)만 고유어 — "24시" 같은 표기는 한자어가 자연스럽다.
            const native = intVal <= 12 ? readNative(intVal) : null;
            if (native) return native;
            return readSino(digits);
          }
          if (NATIVE_COUNTERS.has(counter)) {
            const native = readNative(intVal);
            if (native) return native;
            return readSino(digits); // 100 이상은 한자어(백 개)
          }
        }
      }
    }
    return readSino(digits);
  });

  // ③ 남은 기호: %(퍼센트). 숫자 유무와 무관하게 발음 확정.
  out = out.replace(/%/g, '퍼센트');

  return out;
}
