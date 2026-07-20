import {
  makeBreathSamples,
  makeGapBreath,
  speechStats,
  breathDurMs,
  BREATH_REL_DB,
  GAP_BREATH_MIN_TOTAL_MS,
} from '../tts/sherpa/breathWav';
import { BREATHY_THRESH, estimateWordBoundaries } from '../tts/sherpa/align';
import { hasClauseComma } from '../tts/sherpa/chunkKo';
import { trimEdgeSilence } from '../tts/sherpa/smartSpeed';

// 합성 들숨 스펙(v1.26.0) — `<breath>` 태그는 이 팩 미지원(대조군 실측 2026-07-20)이라
// 절 이음새에 "파형"으로 삽입한다. 보장 사항: 사람 낭독 음량(−18dB)·하이라이트 쉼 문턱
// 이하 피크·결정론.

const SR = 44100;

function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

function peak(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

describe('makeBreathSamples — 합성 들숨', () => {
  const stats = { rms: 0.07, peak: 0.37 }; // 실측 대표값(AB_long_B_chunked.wav)

  test('결정론: 같은 입력이면 항상 같은 파형(캐시 재생성 간 소리 흔들림 금지)', () => {
    const a = makeBreathSamples(SR, 280, stats, '그는 천천히 고개를 들었다');
    const b = makeBreathSamples(SR, 280, stats, '그는 천천히 고개를 들었다');
    expect(a).toEqual(b);
    const c = makeBreathSamples(SR, 280, stats, '다른 절 텍스트');
    expect(a).not.toEqual(c);
  });

  test('길이 = durMs, 무음 아님', () => {
    const out = makeBreathSamples(SR, 300, stats, 'seed');
    expect(out.length).toBe(Math.round((SR * 300) / 1000));
    expect(rms(out)).toBeGreaterThan(0);
  });

  test('음량: RMS ≤ 말소리 −18dB(사람 낭독 관례 상한)', () => {
    const out = makeBreathSamples(SR, 300, stats, 'seed');
    // 엔벨로프 포함 전체 RMS 는 목표(스케일 기준) 이하 — "너무 큼"(−7.6dB 기각) 재발 방지.
    expect(rms(out)).toBeLessThanOrEqual(stats.rms * 10 ** (BREATH_REL_DB / 20) * 1.001);
  });

  test('피크: 문턱×0.85(fitPeak) 이하가 구조적으로 보장(시드·레벨 스윕) — 들숨이 발화로 오분류되지 않는다', () => {
    // crest 상수 가정은 시드에 따라 깨질 수 있어(교차검증 Claude: 20만 시드 중 crest 3.49,
    // 문턱의 98.3% 근접) ④가 실측 피크로 스케일한다 — 어떤 시드든 fitPeak 를 넘지 않아야 한다.
    for (const st of [
      { rms: 0.07, peak: 0.37 },
      { rms: 0.1, peak: 0.55 }, // 고음량 문장
      { rms: 0.03, peak: 0.12 }, // 저음량 문장
    ]) {
      const th = Math.min(BREATHY_THRESH.cap, Math.max(BREATHY_THRESH.floor, st.peak * BREATHY_THRESH.rel));
      for (let i = 0; i < 200; i++) {
        expect(peak(makeBreathSamples(SR, 260, st, `시드 스윕 ${i}`))).toBeLessThanOrEqual(th * 0.85 * 1.0001);
      }
    }
  });

  test('엔벨로프: 서서히 차오르다 끝에서 잦아든다(첫/끝 구간 RMS < 중반부)', () => {
    const out = makeBreathSamples(SR, 300, stats, 'seed');
    const n = out.length;
    const head = rms(out.slice(0, Math.floor(n * 0.1)));
    const mid = rms(out.slice(Math.floor(n * 0.65), Math.floor(n * 0.75)));
    const tail = rms(out.slice(Math.floor(n * 0.97)));
    expect(head).toBeLessThan(mid * 0.5);
    expect(tail).toBeLessThan(mid * 0.5);
  });

  test('전체 무음 발화(rms 0)는 무음 반환(들숨만 울리는 사고 방지)', () => {
    const out = makeBreathSamples(SR, 300, { rms: 0, peak: 0 }, 'seed');
    expect(peak(out)).toBe(0);
  });

  test('하이라이트 통합: 발화 사이에 심은 들숨(+앞뒤 무음)이 쉼으로 분류된다', () => {
    // 0.4s 말소리 + [무음 40ms + 들숨 280ms + 무음 60ms] + 0.4s 말소리 (breathy 모드).
    const st = { rms: 0.35 * Math.SQRT1_2, peak: 0.35 };
    const voice = (n: number): number[] => {
      const v = new Array<number>(n);
      for (let i = 0; i < n; i++) v[i] = 0.35 * Math.sin((2 * Math.PI * 220 * i) / SR);
      return v;
    };
    const sil = (msV: number) => new Array<number>(Math.round((SR * msV) / 1000)).fill(0);
    const samples = [
      ...voice(Math.round(SR * 0.4)),
      ...sil(40),
      ...makeBreathSamples(SR, 280, st, 'seed'),
      ...sil(60),
      ...voice(Math.round(SR * 0.4)),
    ];
    const words = estimateWordBoundaries('앞말 뒷말', samples, SR, { breathy: true });
    expect(words.length).toBe(2);
    // 두 번째 단어는 들숨 구간을 건너뛴 발화 재개 지점(≥ 0.4s + 쉼 380ms) 근처에서 시작.
    expect(words[1].ms).toBeGreaterThanOrEqual(700);
  });
});

describe('makeGapBreath — 문단 들숨 길이 적응(절단 딱 소리 방지, Gemini 교차검증 지적)', () => {
  const GSR = 22050;

  test('넉넉한 쉼은 최대 길이(170ms) 들숨', () => {
    const gb = makeGapBreath(400, GSR);
    expect(gb).not.toBeNull();
    expect(gb!.samples.length).toBe(Math.round((GSR * 170) / 1000));
  });

  test('빠듯한 쉼은 들숨을 줄여서라도 통째로 넣는다(릴리즈 절단 금지)', () => {
    const gb = makeGapBreath(200, GSR)!;
    // lead 30 + tail 30 을 뺀 몫 = 140ms — 쉼 안에 온전히 들어간다.
    expect(gb.samples.length).toBe(Math.round((GSR * 140) / 1000));
    expect(gb.leadMs + 140 + 30).toBeLessThanOrEqual(200);
    // 릴리즈 보존: 끝 5ms RMS 가 중반부보다 확실히 작다(잘렸다면 중반 수준).
    const n = gb.samples.length;
    const rmsOf = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const tail = rmsOf(gb.samples.slice(n - Math.round(GSR * 0.005)));
    const mid = rmsOf(gb.samples.slice(Math.floor(n * 0.65), Math.floor(n * 0.8)));
    expect(tail).toBeLessThan(mid * 0.3);
  });

  test('최소 길이(110ms)도 안 들어가면 null(무음 쉼 유지)', () => {
    expect(makeGapBreath(GAP_BREATH_MIN_TOTAL_MS - 1, GSR)).toBeNull();
    expect(makeGapBreath(GAP_BREATH_MIN_TOTAL_MS, GSR)).not.toBeNull();
    expect(makeGapBreath(100, GSR)).toBeNull();
  });

  test('결정론: 같은 쉼 길이 = 같은 파형(파일 캐시 정합)', () => {
    expect(makeGapBreath(400, GSR)!.samples).toEqual(makeGapBreath(400, GSR)!.samples);
  });
});

describe('speechStats — 발화 레벨 실측(들숨 스케일 기준)', () => {
  test('피크·유성 RMS(무음 제외) 계산, 전체 무음이면 rms 0', () => {
    const voiced = new Array<number>(1000).fill(0.4);
    const silent = new Array<number>(1000).fill(0);
    const st = speechStats([voiced, silent]);
    expect(st.peak).toBeCloseTo(0.4, 6);
    expect(st.rms).toBeCloseTo(0.4, 6); // 무음이 RMS 를 희석하지 않는다
    expect(speechStats([silent]).rms).toBe(0);
  });
});

describe('breathDurMs — 들숨 길이 결정론 변주', () => {
  test('130~170ms 범위(v1.26.2 — 청취 선택), 같은 텍스트 = 같은 길이', () => {
    for (const s of ['가나다', '문을 열자', 'x', '']) {
      const d = breathDurMs(s);
      expect(d).toBeGreaterThanOrEqual(130);
      expect(d).toBeLessThanOrEqual(170);
      expect(breathDurMs(s)).toBe(d);
    }
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
