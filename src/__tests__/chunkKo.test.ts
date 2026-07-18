import { chunkForSynthesis, CHUNK_THRESHOLD } from '../tts/sherpa/chunkKo';

// 장문 절 분할 스펙 — 쉼표 등 자연 경계에서만 자르고, 원문을 재조립하면 정확히 복원돼야
// 한다(글자 유실 = 낭독 유실). 임의 위치 절단 금지.

const LONG =
  '노인은 낡은 외투 깃을 세우고, 골목 끝의 작은 서점으로 걸음을 옮기며, 삼십 년 동안 하루도 빠짐없이 지켜 온 그 자리를 오늘만큼은 낯설게 느꼈다.';

test('짧은 문장은 그대로(분할 없음)', () => {
  const s = '바람이 몹시 차가운 밤이었다.';
  expect(chunkForSynthesis(s)).toEqual([s]);
});

test('임계 이하 길이는 쉼표가 있어도 그대로', () => {
  const s = '바람이 불고, 눈이 내렸다.';
  expect(s.length).toBeLessThanOrEqual(CHUNK_THRESHOLD);
  expect(chunkForSynthesis(s)).toEqual([s]);
});

test('장문은 쉼표 경계에서 분할되고, 이어 붙이면 원문 그대로', () => {
  const chunks = chunkForSynthesis(LONG);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join('')).toBe(LONG);
  // 마지막 청크를 제외한 각 청크는 쉼표(+공백)로 끝난다(모델이 이어지는 억양을 만들도록).
  for (const c of chunks.slice(0, -1)) {
    expect(c.trimEnd().endsWith(',')).toBe(true);
  }
});

test('쉼표 없는 장문은 자르지 않는다(임의 절단 금지)', () => {
  const s = '가'.repeat(120) + '나였다.';
  expect(chunkForSynthesis(s)).toEqual([s]);
});

test('짧은 꼬리 조각은 이웃 청크에 흡수된다', () => {
  const s =
    '그는 골목 끝의 서점과 오래된 종이 냄새와 따뜻한 유리문 불빛을 하나하나 눈에 담고, 마침내 고개를 끄덕이며, 떠났다.';
  const chunks = chunkForSynthesis(s);
  expect(chunks.join('')).toBe(s);
  for (const c of chunks) {
    expect(c.trim().length).toBeGreaterThanOrEqual(12);
  }
});

test('전각 쉼표·세미콜론도 경계로 인정', () => {
  const s =
    '첫 번째 문장은 여기까지 이어지고，두 번째 문장은 조금 더 길게 이어지며；마지막 부분은 이렇게 끝난다고 말할 수 있겠다.';
  const chunks = chunkForSynthesis(s);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join('')).toBe(s);
});
