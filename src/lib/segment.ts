// 한국어 친화 문장 분할. TTS 재생/자막 표시의 기본 단위(문장)를 만든다.
// expo-speech의 입력 상한(대략 수천 자)과 자막 가독성을 위해 긴 문장은 더 쪼갠다.

const MAX_LEN = 280; // 한 자막(문장) 최대 길이. 너무 길면 화면/발화 단위로 부적절.

function hardWrap(s: string): string[] {
  if (s.length <= MAX_LEN) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_LEN) {
    // 쉼표/공백 등 자연 경계에서 자른다.
    let cut = -1;
    for (const sep of ['. ', ', ', '; ', ' ', '，', '、']) {
      const idx = rest.lastIndexOf(sep, MAX_LEN);
      if (idx > MAX_LEN * 0.5) { cut = idx + sep.length; break; }
    }
    if (cut < 0) cut = MAX_LEN;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// 한 줄을 문장들로 분할. v1.25.1 에서 정규식 단발 분할을 규칙 기반으로 교체 — 소설 텍스트의
// 오분할 3종("한 문장을 막 나눠 읽는다" 사용자 보고 2026-07-20)을 잡는다:
//   ① 대사+지문: 「"가자." 그가 말했다.」 — 종결부호가 닫는 따옴표 "안"이면 문장 계속
//      (대사와 지문은 한 낭독 단위. 멀티보이스는 어차피 splitDialogue 가 문장 안에서 처리).
//   ② 문장 중간 말줄임: 「그는… 조용히 걸었다.」 — …는 종결이 아니라 머뭇거림인 경우가
//      많아, 뒤에 여는 따옴표(새 발화)가 올 때만 문장 경계로 본다. 진짜 문장 끝 …를
//      놓치면 두 문장이 한 단위로 붙을 뿐(무해) — 반대 방향(오분할)이 체감 결함이다.
//   ③ 날짜·번호 파편: 「1945. 8. 15.」 「1. 서장」 — 숫자 뒤 마침표는 다음 어절이 숫자로
//      시작하거나(날짜 연쇄) 마침표 앞 어절이 숫자뿐이면(장 번호) 경계가 아니다. 파편은
//      "천구백사십오." 처럼 숫자 낭독까지 망가뜨렸다(숫자 오독 보고의 유력 원인).
// 줄 안의 인용 스팬(여닫는 짝의 인덱스). 다중 문장 대사(「첫 문장이다. 둘째다.」)의 안쪽
// 종결부호를 경계로 오인하지 않기 위한 추적(교차검증 지적 2026-07-20 — 스팬 미추적이면
// 여는 따옴표가 앞 조각에 고아로 남는다). 짝 잃은 따옴표 폭주 방지 상한은 dialogue.ts 의
// MAX_QUOTE_SPAN 과 같은 값.
const QUOTE_PAIRS: Record<string, string> = {
  '“': '”',
  '「': '」',
  '『': '』',
  '‘': '’',
  '"': '"',
};
const MAX_QUOTE_SPAN = 600;
function quoteSpans(line: string): Array<{ s: number; e: number }> {
  const spans: Array<{ s: number; e: number }> = [];
  for (let i = 0; i < line.length; i++) {
    const close = QUOTE_PAIRS[line[i]];
    if (!close) continue;
    const j = line.indexOf(close, i + 1);
    if (j > 0 && j - i <= MAX_QUOTE_SPAN) {
      spans.push({ s: i, e: j });
      i = j; // 닫는 짝 뒤부터 계속(직선 따옴표 " 는 홀짝 순차 짝짓기)
    }
  }
  return spans;
}

export function splitLineToSentences(line: string): string[] {
  const out: string[] = [];
  const spans = quoteSpans(line);
  let start = 0;
  // 종결부호(…포함) + 공백 = 후보 경계. 규칙으로 진짜 경계만 남긴다. 닫는 부호에 낫표
  // (」』)도 포함 — 낫표 대사도 큰따옴표와 같은 ① 규칙을 타게(경화, 교차검증 지적).
  const re = /[.!?。！？…]+["'”’)\]」』]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const token = m[0];
    const punct = token.replace(/["'”’)\]」』\s]/g, ''); // 종결부호 부분만
    const before = line[m.index - 1] || ''; // 종결부호 직전 글자
    const afterIdx = m.index + token.length;
    const after = line[afterIdx] || ''; // 다음 문장 후보의 첫 글자
    const closedQuote = /["'”’」』]/.test(token); // 부호가 따옴표 안에서 끝났는가

    let boundary = true;
    // 인용 스팬 "안"의 종결부호(토큰이 닫는 짝을 포함하지 않는 경우)는 대사 내부 문장 —
    // 경계 아님. 토큰이 닫는 짝을 지나면(afterIdx > e) 아래 closedQuote 규칙이 처리.
    const inSpan = spans.some((sp) => m!.index > sp.s && afterIdx <= sp.e);
    if (inSpan) {
      boundary = false;
    } else if (closedQuote) {
      // ① 대사 닫힘 — 지문(꼬리표)이 이어지면 한 문장. 단, 바로 새 대사가 시작되면
      // ("왔니?" "응.") 발화 단위가 다르므로 경계(교차검증 지적 채택, 실측 재현).
      boundary = /["'“‘「『]/.test(after);
    } else if (/^…+$/.test(punct) || /^\.{2,}$/.test(punct)) {
      boundary = /["'“‘「『]/.test(after); // ② 말줄임 — 새 발화 시작일 때만 경계
    } else if (punct === '.' && /\d/.test(before)) {
      // ③ 숫자 뒤 마침표: 다음 어절이 숫자(날짜 연쇄 진행 중)이거나, 직전 어절이 짧은
      // 숫자뿐(장 번호 "1." · 날짜 연쇄의 마지막 "15.")이면 경계가 아니다. 「그 해는
      // 1945. 다음 문장」 같은 진짜 종결도 붙게 되지만(병합), 소설에서 드물고 병합은
      // 오분할(파편 낭독)보다 무해하다.
      // 직전 어절은 뒤에서부터 역방향 스캔으로 얻는다 — start 부터 slice 하면 경계 거부가
      // 반복되는 병리 입력("1. 1. 1. …")에서 O(n²)로 자란다(교차검증 codex 실측).
      let ws = m.index;
      while (ws > start && !/\s/.test(line[ws - 1])) ws--;
      const lastTok = line.slice(ws, m.index);
      if (/^\d/.test(after) || /^\d{1,4}$/.test(lastTok)) boundary = false;
    }
    if (boundary) {
      out.push(line.slice(start, afterIdx).trim());
      start = afterIdx;
    }
  }
  if (start < line.length) {
    const rest = line.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out.length ? out : [line];
}

export type SegmentedDoc = {
  sentences: string[];
  /** 문단을 새로 시작하는 문장 인덱스들(0 = 첫 문단). 낭독 페이스(pacing.ts)가 문단 전환
   *  호흡에 쓴다. 원문 텍스트는 저장하지 않으므로 여기서 계산해 문서와 함께 보존해야 한다. */
  paraStarts: number[];
};

export function segmentDocument(raw: string): SegmentedDoc {
  if (!raw) return { sentences: [], paraStarts: [] };
  // 개행/공백 정규화 (단, 문단 경계는 살린다)
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n');

  // 문단 = 빈 줄(\n\n) 경계만. 단일 개행은 하드랩(80자 접기 등)일 수 있어 문단으로 치지
  // 않는다 — 매 줄이 문단이 되면 낭독 페이스의 문단 호흡(+350ms)이 줄마다 붙는 역효과.
  // (문장 분할 자체는 종전대로 줄 단위 — 줄을 넘나드는 문장 결합은 하지 않는다.)
  const blocks = text.split(/\n\n/);
  const sentences: string[] = [];
  const paraStarts: number[] = [];

  for (const block of blocks) {
    let blockStarted = false;
    for (const line of block.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      if (!blockStarted) {
        paraStarts.push(sentences.length);
        blockStarted = true;
      }
      const parts = splitLineToSentences(p);
      for (const part of parts) {
        const s = part.trim();
        if (!s) continue;
        for (const chunk of hardWrap(s)) {
          if (chunk) sentences.push(chunk);
        }
      }
    }
  }
  return { sentences, paraStarts };
}

export function segmentSentences(raw: string): string[] {
  return segmentDocument(raw).sentences;
}
