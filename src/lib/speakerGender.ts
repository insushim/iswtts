// 대사 화자 성별 추정(순수 함수 — 테스트 대상). "대사는 다른 목소리로" 기능의 자동 대비를
// 남/여까지 구분해 준다(사용자 요청 2026-07-20 "남자 구분해줄 수 있나").
//
// 방법: 대사(따옴표 안)를 지우고 남은 지문에서 성별 단서 어휘를 찾는다 — 소설 관행상
// 대사 문장의 지문("…" 그가 말했다 / 어머니가 웃으며 …)에 화자가 명시되는 경우가 많다.
// v1.25.1 의 문장 분할 수정(대사+지문 = 한 문장)이 전제 — 그 전엔 지문이 다른 문장으로
// 떨어져 나가 단서를 볼 수 없었다.
//
// 한계(설계상 허용): 지문 없는 연속 대화(「"왔니?" "응."」)나 이름만 있는 화자("지수가
// 말했다")는 판별 불가 → null 을 돌려주고 호출부가 기존 자동 대비(중립)로 폴백한다.
// 두 성별 단서가 같이 있으면("그가 어머니에게 말했다") 오귀속 위험이 커 null.

// 인용 스팬 제거용. dialogue.ts 의 대사 짝(큰따옴표 계열)보다 넓게 — 홑따옴표(생각)·
// 겹낫표(제목)도 지운다: 그 안의 성별 어휘("'그녀를 봤어?' 하고 물었다")가 지문 판정에
// 새면 오귀속된다(교차검증 Gemini 지적, 실측 재현 확인 2026-07-20).
const QUOTE_SPANS = /“[^”]*”|"[^"]*"|「[^」]*」|‘[^’]*’|'[^']*'|『[^』]*』/g;

// 지문 성별 단서. 호칭·지칭 명사는 소설 지문에서 화자 표지로 쓰이는 빈도 높은 것만 —
// 과욕(이름 사전 등)은 오귀속을 늘린다.
// 주격류 조사(가/이/는/은/도)가 바로 뒤따를 때만 단서로 인정: "철수가 그녀에게 말했다"의
// "그녀에게"(여격=청자)를 화자로 오인하지 않게(교차검증 codex 지적, 실측 재현). 부수 효과로
// "그녀석"(그+녀석)·"여자였다"(서술어) 같은 비주어 꼴도 걸러진다.
// v1.27.0: 어휘 확장(딸·이모·고모·여동생·며느리 / 아들·삼촌·도련님·오빠 — 소설 지문의
// 화자 표지 빈도 상위만) + 소유격 꼴 인정("그녀의 목소리가 떨렸다"·"사내의 말이 짧았다").
// 소유격은 뒤에 발화 명사가 올 때만 — "어머니의 손을 잡았다"(화자 아님)를 배제한다.
const FEMALE_WORDS =
  '그녀|여자|소녀|여인|아주머니|아줌마|할머니|어머니|엄마|아내|부인|아가씨|언니|누나|누이|딸|이모|고모|여동생|며느리';
const MALE_WORDS =
  '사내|남자|소년|아저씨|할아버지|아버지|아빠|남편|영감|청년|형님|오라버니|아들|삼촌|도련님|오빠';
// 소유격 뒤에 오면 화자 표지로 인정하는 발화 명사.
// ⚠️ 더 긴 어휘가 먼저 와야 한다(정규식 alternation 은 선순위 매치) — '말'이 앞에 있으면
// '말투' 분기는 영원히 도달 불가(교차검증 지적 2026-07-21).
const SPEECH_NOUN = '목소리|음성|말투|말|대답|물음|외침|목청|한숨';
function cueRe(words: string): RegExp {
  return new RegExp(`(?:${words})(?:(?=[가이는은도])|(?=의\\s?(?:${SPEECH_NOUN})))`, 'g');
}
const FEMALE_CUES = cueRe(FEMALE_WORDS);
const MALE_CUES = cueRe(MALE_WORDS);
// 3인칭 남성 대명사 "그가/그는/그도"(+ "그의 목소리") — "그날/그때" 같은 지시어와 구분하려고
// 조사까지 본다. ("그녀가"는 그+녀 라서 이 패턴에 걸리지 않는다.)
const HE_PRONOUN = /(^|[^가-힣])그(?:[가는도](?=[^가-힣]|$)|의\s?(?:목소리|음성|말|대답|물음))/g;
// 발화 동사 — 남/여 단서가 함께 있을 때 "누가 말했는가"를 가르는 기준점(v1.27.0).
// 한국어 지문은 화자가 발화 동사 "앞"에 오므로("그가 어머니에게 말했다"), 동사 직전의
// 가장 가까운 단서를 화자로 본다. 이전 버전은 이런 문장을 통째로 null(중립 폴백)로 버렸다.
// ⚠️ 이 규칙은 "발화 동사가 문장에 딱 하나"일 때만 쓴다(아래 guessDialogueGender). 둘 이상이면
// 어느 절이 대사의 주인인지 텍스트만으로는 못 가른다 — 교차검증 Gemini 재현 2026-07-21:
//   "그녀가 사과를 베어 물었고 그가 말했다."  ← "물었"이 먹다(bite) 뜻인데 발화로 잡힘
//   "어머니가 말하자 그가 물었다."            ← 종속절 동사가 주절보다 앞에 옴
// 둘 다 "가장 앞선 동사 기준"이면 정확히 반대 성별로 귀속됐다. 모호하면 null(중립 폴백)이
// 오귀속보다 낫다는 이 파일의 기존 방침을 그대로 따른다.
const SPEECH_VERB =
  /(말했|말하|물었|묻는|외쳤|외치|속삭였|속삭이|대답했|답했|중얼거|되물었|소리쳤|덧붙였|입을 열)/g;

export type SpeakerGender = 'male' | 'female';

type Cue = { idx: number; gender: SpeakerGender };

function cuesIn(narration: string): Cue[] {
  const out: Cue[] = [];
  const collect = (re: RegExp, gender: SpeakerGender) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(narration))) out.push({ idx: m.index, gender });
  };
  collect(FEMALE_CUES, 'female');
  collect(MALE_CUES, 'male');
  collect(HE_PRONOUN, 'male');
  return out.sort((a, b) => a.idx - b.idx);
}

export function guessDialogueGender(sentence: string): SpeakerGender | null {
  const narration = sentence.replace(QUOTE_SPANS, ' ');
  if (!narration.trim()) return null; // 지문 없음(통짜 대사)
  const cues = cuesIn(narration);
  if (!cues.length) return null;
  const first = cues[0].gender;
  if (cues.every((c) => c.gender === first)) return first;
  // 남/여 혼재 — 발화 동사 직전의 가장 가까운 단서를 화자로 본다(주격 조사가 붙은 단서만
  // 모아 두었으므로 여격·목적격 청자는 애초에 후보가 아니다). 단, 발화 동사가 "딱 하나"일
  // 때만: 둘 이상이면 어느 절이 대사의 주인인지 못 가른다(SPEECH_VERB 주석의 재현 사례).
  SPEECH_VERB.lastIndex = 0;
  const verbs = narration.match(SPEECH_VERB);
  if (!verbs || verbs.length !== 1) return null;
  const v = narration.indexOf(verbs[0]);
  if (v < 0) return null;
  let best: Cue | null = null;
  for (const c of cues) if (c.idx < v && (!best || c.idx > best.idx)) best = c;
  return best ? best.gender : null;
}

// 문서 단위 2패스 추정(v1.25.3 — "남녀 구분이 잘 안 된다" 후속). 소설 대사의 다수는
// 같은 문장에 지문이 없다(대사만 한 문단/이름만 있는 꼬리표) — 1패스가 null 이면:
//   앞 문장이 대사 없는 순수 지문이고 성별 단서가 있으면 그걸 쓴다("사내가 입을 열었다."
//   → 다음 줄 대사 = 화자 소개 관행) → 없으면 다음 문장 지문(꼬리표 후행 관행)을 본다.
// 대화가 이어지는 구간(양쪽 다 대사)은 확장하지 않는다 — 교대 화자를 넘겨짚으면 절반이
// 오귀속이라 null(폴백)이 낫다.
const WINDOW = 2; // 앞/뒤로 훑을 지문 문장 수(대사 문장을 만나면 중단)
export function guessDialogueGenders(
  sentences: string[],
  paraStarts?: ReadonlySet<number>,
): Array<SpeakerGender | null> {
  const hasQuote = sentences.map((s) => {
    QUOTE_SPANS.lastIndex = 0;
    return QUOTE_SPANS.test(s);
  });
  const own = sentences.map(guessDialogueGender);
  const result = sentences.map((s, i) => {
    if (own[i]) return own[i];
    if (!hasQuote[i]) return null; // 지문 문장 자체는 확장 대상 아님
    // v1.27.0: 탐색 창 1 → 2 문장. 소설은 "사내가 문을 열었다. 잠시 망설였다. '누구요?'"
    // 처럼 화자 소개와 대사 사이에 지문이 한 줄 더 끼는 경우가 흔하다(사용자 보고 2026-07-21
    // "아직도 남녀 구분을 잘 못한다"). 대사 문장을 만나면 즉시 중단 — 그때부터는 화자가
    // 바뀌었을 수 있어 넘겨짚기가 된다.
    // ⚠️ 문단(장면) 경계를 넘지 않는다 — 넘으면 앞 장면 마지막 지문의 성별이 새 장면 첫
    // 대사로 새어 든다(교차검증 Gemini 2026-07-21: 창을 2로 넓히며 노출 면적이 커졌다).
    // paraStarts 는 문단을 "시작하는" 문장 인덱스 집합(segment.ts) — 뒤로 훑을 땐 지금
    // 문장이 문단 머리인 순간, 앞으로 훑을 땐 다음 문장이 문단 머리인 순간 멈춘다.
    const scan = (from: number, step: number): SpeakerGender | null => {
      for (let k = from, n = 0; k >= 0 && k < sentences.length && n < WINDOW; k += step, n++) {
        if (paraStarts?.has(step < 0 ? k + 1 : k)) return null;
        if (hasQuote[k]) return null;
        if (own[k]) return own[k];
      }
      return null;
    };
    return scan(i - 1, -1) ?? scan(i + 1, 1);
  });
  alternateDialogueRuns(result, sentences.map((s) => DIALOGUE_QUOTE.test(s)), paraStarts);
  return result;
}

// 교대 전파 상한 — 앵커(확정 문장)에서 이 거리까지만 채운다. 런이 길어질수록 "번갈아
// 말한다" 관행이 흐트러질(끼어드는 3자·같은 화자 연속) 확률이 커진다.
const ALT_MAX_DIST = 8;
// 런 멤버십 판정용 "대사" 따옴표 — dialogue.ts PAIRS(발화로 취급하는 큰따옴표 계열)와
// 정렬. QUOTE_SPANS(hasQuote)는 홑따옴표(생각)·낫표(제목)까지 넓게 봐서, '강조'나 『책
// 제목』만 있는 지문이 런에 끼어 패리티를 밀거나 별개 대화 둘을 하나로 이어 붙인다 —
// 교대 전파는 실제 발화 턴에만 건다.
const DIALOGUE_QUOTE = /[“”"「」]/;

// 3패스(v1.27.1): 대화 런(연속 대사 문장) 교대 전파. 한국 소설 조판 관행상 따옴표 대사가
// 잇달아 나오면(각 턴이 별도 문장) 두 화자가 번갈아 말하는 교환이 압도적이다. 기존
// 2패스는 런의 가장자리 문장만 인접 지문 단서를 받아 안쪽이 전부 미상 — 미상은 재생부가
// "기본 화자의 반대 성별"로 폴백하므로 남/녀 교환의 절반이 통째로 남성으로 들렸다
// ("지금은 거의 다 남자 목소리" 사용자 보고 2026-07-23). 런 안에 확정 문장이 하나라도
// 있고 확정들끼리 패리티(홀짝 위치-성별 대응)가 모순 없으면 가까운 앵커에서 교대로 채운다.
// 가드(오귀속 방지 — "교대 화자 넘겨짚기 금지" 기존 방침의 완화 조건):
//  ① 앵커 없는 런은 그대로 둔다(무근거 넘겨짚기 금지 유지).
//  ② 확정끼리 패리티 모순이면 런 전체 포기(같은 화자 연속 발화 등 관행 밖 구조 신호).
//  ③ 전파 거리 상한(ALT_MAX_DIST).
//  ④ 문단(장면) 경계를 넘지 않는다 — 2패스의 paraStarts 가드와 동형(교차검증 Gemini
//     CRITICAL 2026-07-23: 지문 없이 장면이 바뀌는 연속 대사에서 앞 장면 패리티가 새어
//     든다). 대화 턴은 관행상 "단일 개행"이라 빈 줄 문단(paraStarts)은 실제 장면 전환.
function alternateDialogueRuns(
  result: Array<SpeakerGender | null>,
  hasQuote: boolean[],
  paraStarts?: ReadonlySet<number>,
): void {
  const flip = (g: SpeakerGender): SpeakerGender => (g === 'male' ? 'female' : 'male');
  let i = 0;
  while (i < result.length) {
    if (!hasQuote[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < result.length && hasQuote[j + 1] && !paraStarts?.has(j + 1)) j++;
    if (j > i) {
      const anchors: number[] = [];
      for (let k = i; k <= j; k++) if (result[k]) anchors.push(k);
      // 패리티 일관성: 모든 앵커 쌍이 "거리 짝수 = 같은 성별"을 만족해야 교대 전파.
      const consistent =
        anchors.length > 0 &&
        anchors.every(
          (k) => ((k - anchors[0]) % 2 === 0) === (result[k] === result[anchors[0]]),
        );
      if (consistent) {
        for (let k = i; k <= j; k++) {
          if (result[k]) continue;
          let best = -1;
          for (const a of anchors) if (best < 0 || Math.abs(k - a) < Math.abs(k - best)) best = a;
          if (best >= 0 && Math.abs(k - best) <= ALT_MAX_DIST) {
            const g = result[best] as SpeakerGender;
            result[k] = (k - best) % 2 === 0 ? g : flip(g);
          }
        }
      }
    }
    i = j + 1;
  }
}

// Supertonic 3 화자(sid 0~9)의 성별 — F0 자기상관 실측(2026-07-20, sid_gender.py):
// 0~4 = 여(172~253Hz), 5~9 = 남(85~151Hz). Supertone 배포의 voice_styles F1~F5/M1~M5
// 명명과 일치. 배열 순서 = 대사 음성으로 고를 때의 선호 순(음색 대비가 또렷한 순).
export const SHERPA_FEMALE_SIDS = ['1', '3', '2', '4', '0'];
export const SHERPA_MALE_SIDS = ['6', '7', '8', '5', '9'];
