import { injectBreathInline, hasClauseComma } from '../tts/sherpa/chunkKo';
import { trimEdgeSilence } from '../tts/sherpa/smartSpeed';

// 인라인 숨 주입 스펙 — 분할되지 않는 문장의 "가운데 절 경계 뒤"에 <breath> 를 심는다.
// (모델 태그가 낭독 흐름 안에서 들숨으로 렌더됨 — 실측 2026-07-18, 태그 미발음 +0.36s.)

describe('injectBreathInline', () => {
  test('쉼표 뒤(공백 포함 경계 다음)에 심는다', () => {
    expect(injectBreathInline('문을 열자, 차가운 공기가 밀려들었다.')).toBe(
      '문을 열자, <breath> 차가운 공기가 밀려들었다.',
    );
  });

  test('경계가 여럿이면 모든 유효 경계에 심는다(v1.24.0 — 쉼표마다 숨)', () => {
    expect(injectBreathInline('문을 열자, 바람이 불어와, 촛불이 흔들렸다.')).toBe(
      '문을 열자, <breath> 바람이 불어와, <breath> 촛불이 흔들렸다.',
    );
  });

  test('짧은 후속 절(열거)은 건너뛴다 — 헐떡임 방지', () => {
    expect(injectBreathInline('하나, 둘, 셋, 넷을 세었다.')).toBe(
      '하나, 둘, 셋, <breath> 넷을 세었다.',
    );
  });

  test('닫는 따옴표가 붙은 경계도 그 뒤에 심는다', () => {
    expect(injectBreathInline('"그래," 하고 그는 말했다.')).toBe(
      '"그래," <breath> 하고 그는 말했다.',
    );
  });

  test('경계가 없으면 원문 그대로(숨 생략)', () => {
    const s = '쉼표 없는 문장은 그대로 둔다.';
    expect(injectBreathInline(s)).toBe(s);
  });

  test('문장 끝에만 쉼표류가 있으면 심을 자리가 없다', () => {
    const s = '끝에만 쉼표가 있는 문장,';
    expect(injectBreathInline(s)).toBe(s);
  });

  test('숫자 사이 쉼표(비정형 자릿수 표기)에는 심지 않는다', () => {
    const s = '좌표 1,50 지점에서 만나자고 했다.';
    expect(injectBreathInline(s)).toBe(s);
    // 진짜 절 쉼표가 따로 있으면 그쪽에 심는다.
    expect(injectBreathInline('좌표 1,50 지점, 그곳에서 기다렸다.')).toBe(
      '좌표 1,50 지점, <breath> 그곳에서 기다렸다.',
    );
  });
});

describe('hasClauseComma(숨 심을 절 경계 판정 — breathApplies 의 반쪽)', () => {
  test('절 쉼표는 참, 자릿수 쉼표만 있으면 거짓', () => {
    expect(hasClauseComma('문을 열자, 공기가 밀려들었다.')).toBe(true);
    expect(hasClauseComma('가격은 12,500원이었다.')).toBe(false);
    expect(hasClauseComma('총액 1,234,567원을 정산했다.')).toBe(false);
    expect(hasClauseComma('쉼표가 없는 문장이다.')).toBe(false);
    // 자릿수 쉼표와 절 쉼표가 섞이면 절 쉼표로 참.
    expect(hasClauseComma('가격은 12,500원이었고, 그는 놀랐다.')).toBe(true);
    // 전각 쉼표·세미콜론도 절 경계.
    expect(hasClauseComma('그러나， 아무도 없었다.')).toBe(true);
  });
});

describe('trimEdgeSilence 절단면 페이드', () => {
  // 앞 0.5s 무음 + 말소리 + 뒤 1s 무음 — 양끝 컷이 확실히 일어나는 형태.
  function makeAudio(sr: number): number[] {
    const x: number[] = [];
    for (let i = 0; i < sr * 0.5; i++) x.push(0.001);
    for (let i = 0; i < sr * 0.5; i++) x.push(0.5);
    for (let i = 0; i < sr * 1.0; i++) x.push(0.001);
    return x;
  }

  test('fadeMs=0(기본)은 기존과 동일 — 컷 지점 값이 그대로', () => {
    const sr = 44100;
    const out = trimEdgeSilence(makeAudio(sr), sr);
    expect(Math.abs(out[0])).toBeCloseTo(0.001, 6);
    expect(Math.abs(out[out.length - 1])).toBeCloseTo(0.001, 6);
  });

  test('fadeMs>0 이면 컷이 일어난 양끝이 0 에서 시작·끝난다(틱 제거)', () => {
    const sr = 44100;
    const out = trimEdgeSilence(makeAudio(sr), sr, undefined, undefined, 8);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
    // 페이드는 가장자리 8ms 에만 — 본문(말소리)은 불변.
    const mid = Math.floor(out.length / 2);
    expect(Math.abs(out[mid])).toBeCloseTo(0.5, 6);
  });

  test('컷이 없으면 페이드도 없다(원본 유지)', () => {
    const sr = 44100;
    const x = new Array<number>(sr).fill(0.5); // 전체 말소리 — 트림 불발
    const out = trimEdgeSilence(x, sr, undefined, undefined, 8);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 6);
  });
});
