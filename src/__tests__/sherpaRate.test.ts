import { sherpaModelSpeed, sherpaPlaybackRate, sherpaTrimEnabled } from '../tts/sherpa/rate';

describe('sherpa 배속(상한 없음 — 스트레치 3× 우선, 초과분 모델)', () => {
  test('1× — 둘 다 중립', () => {
    expect(sherpaModelSpeed(1)).toBe(1);
    expect(sherpaPlaybackRate(1)).toBe(1);
  });

  test('설정 배속 무조건 적용 — 곱 = 요청 배속(9×까지), 상한 클램프 없음(핵심 불변식)', () => {
    for (const r of [1.5, 2, 3, 3.6, 4, 5, 6, 9]) {
      expect(sherpaModelSpeed(r) * sherpaPlaybackRate(r)).toBeCloseTo(r, 5);
    }
    // 9× 초과는 모델 무음 경계(3.0) 유지 + 잔여를 스트레치가 흡수
    expect(sherpaModelSpeed(10)).toBe(3);
    expect(sherpaPlaybackRate(10)).toBeCloseTo(10 / 3, 5);
  });

  test('≤3×는 스트레치 전담(모델 개입 금지 — 음소 붕괴 CER 실측 2.0=72%)', () => {
    for (const r of [1.5, 2, 2.5, 3]) {
      expect(sherpaModelSpeed(r)).toBe(1);
      expect(sherpaPlaybackRate(r)).toBe(r);
    }
  });

  test('3× 초과 — 스트레치 3.0 고정, 초과분만 모델(조합이 순수 스트레치보다 우수 실측)', () => {
    expect(sherpaPlaybackRate(4)).toBeCloseTo(3, 5);
    expect(sherpaModelSpeed(4)).toBeCloseTo(4 / 3, 5);
    expect(sherpaModelSpeed(6)).toBeCloseTo(2, 5);
  });

  test('저속(<1×)은 모델 전담', () => {
    expect(sherpaModelSpeed(0.7)).toBe(0.7);
    expect(sherpaModelSpeed(0.3)).toBe(0.5);
    expect(sherpaPlaybackRate(0.7)).toBe(1);
  });
});

describe('스마트 스피드(무음 압축) 연동', () => {
  test('적용 정책 — 스트레치 온전 구간(≤3×)은 미적용, 초고배속(>3×)만', () => {
    for (const r of [0.5, 1, 2, 3]) expect(sherpaTrimEnabled(r)).toBe(false);
    for (const r of [3.01, 4, 5, 10]) expect(sherpaTrimEnabled(r)).toBe(true);
    expect(sherpaTrimEnabled(undefined)).toBe(false);
  });

  test('곱 불변식 유지 — 모델 × 압축몫 × 재생속도 = 설정 배속(압축은 스트레치에서만 차감)', () => {
    for (const r of [3.5, 4, 5, 6, 9]) {
      for (const f of [1, 1.15, 1.3]) {
        expect(sherpaModelSpeed(r) * f * sherpaPlaybackRate(r, f)).toBeCloseTo(r, 5);
      }
    }
    // 3<r≤9 구간에서 실효 스트레치 = 3/f (압축이 스트레치를 직접 덜어낸다)
    expect(sherpaPlaybackRate(5, 1.25)).toBeCloseTo(3 / 1.25, 5);
    expect(sherpaPlaybackRate(4, 1.2)).toBeCloseTo(3 / 1.2, 5);
  });

  test('비정상 trimFactor(NaN·<1)는 1로 취급 — 기존 동작과 동일', () => {
    expect(sherpaPlaybackRate(4, NaN)).toBeCloseTo(sherpaPlaybackRate(4), 5);
    expect(sherpaPlaybackRate(4, 0.5)).toBeCloseTo(sherpaPlaybackRate(4), 5);
  });
});

describe('sherpaTempoComp — 짧은 문장 템포 평준화(v1.24.0)', () => {
  const { sherpaTempoComp } = require('../tts/sherpa/rate');
  test('긴 문장(35음절+)은 보정 없음, 짧을수록 0.88 까지 감속', () => {
    expect(sherpaTempoComp('가'.repeat(40))).toBe(1);
    expect(sherpaTempoComp('가'.repeat(35))).toBe(1);
    expect(sherpaTempoComp('가'.repeat(12))).toBeCloseTo(0.88, 5);
    expect(sherpaTempoComp('짧다.')).toBeCloseTo(0.88, 5);
    const mid = sherpaTempoComp('가'.repeat(24));
    expect(mid).toBeGreaterThan(0.88);
    expect(mid).toBeLessThan(1);
  });
  test('음절 수는 한글만 센다(숫자·구두점 무관)·결정적', () => {
    const s = '삼십 년 동안, 하루도 빠짐없이 지켜 온 자리를 오늘만큼은 낯설게 느꼈다.';
    expect(sherpaTempoComp(s)).toBe(sherpaTempoComp(s));
  });
});

describe('sherpaRubato — 문장 완급 변주(v1.25.0)', () => {
  const { sherpaRubato, SPEED_COMP_FLOOR } = require('../tts/sherpa/rate');
  test('결정적: 같은 문장은 항상 같은 인자(재생마다 달라지면 고장으로 들린다)', () => {
    const s = '노인은 낡은 외투 깃을 세우고 골목 끝의 서점으로 걸음을 옮겼다.';
    expect(sherpaRubato(s)).toBe(sherpaRubato(s));
  });
  test('값 범위: 1(변주 없음) 또는 [0.90, 0.96](너무 느려지지 않게)', () => {
    for (let i = 0; i < 300; i++) {
      const f = sherpaRubato(`테스트 문장 번호 ${i} 입니다. 서로 다른 해시를 위해.`);
      if (f !== 1) {
        expect(f).toBeGreaterThanOrEqual(0.9);
        expect(f).toBeLessThanOrEqual(0.96);
      }
    }
  });
  test('발동 비율 ≈ 30% ("가끔"이어야 사람같다 — 통계 허용 오차 ±12%p)', () => {
    let slowed = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      if (sherpaRubato(`통계 검사용 문장 ${i} — 완급 변주 비율을 잰다.`) !== 1) slowed++;
    }
    expect(slowed / N).toBeGreaterThan(0.18);
    expect(slowed / N).toBeLessThan(0.42);
  });
  test('tempoComp 와의 곱 하한(SPEED_COMP_FLOOR)은 실측 검증 구간 안', () => {
    expect(SPEED_COMP_FLOOR).toBeGreaterThanOrEqual(0.85);
    expect(SPEED_COMP_FLOOR).toBeLessThan(0.9);
  });
  test('빈 문자열·기호만인 입력도 안전(범위 밖 값 없음)', () => {
    for (const s of ['', '…', '!!!', '12,500']) {
      const f = sherpaRubato(s);
      expect(f === 1 || (f >= 0.9 && f <= 0.96)).toBe(true);
    }
  });
  test('문맥 완급(v1.26.0): 말줄임 문장은 주사위와 무관하게 항상 감속 [0.90, 0.94]', () => {
    for (let i = 0; i < 100; i++) {
      const f = sherpaRubato(`그는 아무 말도 하지 못했다 ${i}…`);
      expect(f).toBeGreaterThanOrEqual(0.9);
      expect(f).toBeLessThanOrEqual(0.94);
    }
    // 닫는 따옴표가 붙어도 여운 판정("…' 로 끝나는 대사).
    expect(sherpaRubato('"어쩌면, 그럴지도…"')).toBeLessThanOrEqual(0.94);
    // 세 점 마침표(...)도 말줄임.
    expect(sherpaRubato('기억이 나지 않았다...')).toBeLessThanOrEqual(0.94);
  });
  test('말줄임이 문장 중간에만 있으면 일반 주사위 규칙(항상-감속 아님)', () => {
    // 같은 꼬리(평서)로 끝나는 문장 무리에서 1 이 존재해야 한다 — 중간 말줄임이 전부를
    // 감속시키면 실패.
    let anyNeutral = false;
    for (let i = 0; i < 60; i++) {
      if (sherpaRubato(`그는… 잠시 망설였지만 결국 문을 열었다 ${i}.`) === 1) anyNeutral = true;
    }
    expect(anyNeutral).toBe(true);
  });
});

describe('sherpaPaceComp — 재생 완급 인자(v1.26.1: 합성 speed → 피치보존 스트레치 이동)', () => {
  const { sherpaPaceComp, sherpaTempoComp, sherpaRubato, SPEED_COMP_FLOOR } = require('../tts/sherpa/rate');
  test('기본 조합: tempoComp × rubato, 하한 SPEED_COMP_FLOOR·상한 1 클램프', () => {
    expect(sherpaPaceComp(1, 1, { rate: 1, rubatoOn: true })).toBe(1);
    expect(sherpaPaceComp(0.88, 0.9, { rate: 1, rubatoOn: true })).toBe(SPEED_COMP_FLOOR);
    expect(sherpaPaceComp(0.95, 0.95, { rate: 1.5, rubatoOn: true })).toBeCloseTo(0.9025, 6);
  });
  test('rubatoOn=false 면 루바토 제외(템포 평준화만)', () => {
    expect(sherpaPaceComp(0.92, 0.9, { rate: 1, rubatoOn: false })).toBeCloseTo(0.92, 6);
  });
  test('>3×(스마트 스피드)는 완급 무시(1) — 압축 몫 계산과 불간섭', () => {
    expect(sherpaPaceComp(0.88, 0.9, { rate: 4, rubatoOn: true })).toBe(1);
  });
  test('비정상 입력(NaN·0·음수)은 1 취급 — 재생속도 오염 방지', () => {
    expect(sherpaPaceComp(NaN, 0.9, { rate: 1, rubatoOn: true })).toBeCloseTo(0.9, 6);
    expect(sherpaPaceComp(0.95, 0, { rate: 1, rubatoOn: true })).toBeCloseTo(0.95, 6);
    expect(sherpaPaceComp(-1, NaN, { rate: 1, rubatoOn: true })).toBe(1);
  });
  test('최저 배속(0.5×)에서도 최종 재생속도 = 1 × comp ≥ expo-audio 하한(0.5)', () => {
    const comp = sherpaPaceComp(sherpaTempoComp('짧다.'), sherpaRubato('짧다.'), { rate: 0.5, rubatoOn: true });
    expect(comp).toBeGreaterThanOrEqual(SPEED_COMP_FLOOR);
    expect(1 * comp).toBeGreaterThanOrEqual(0.5);
  });
});

describe('루바토 배속 게이트(v1.27.1) — >2×에선 완급 변주가 "가끔 느려짐" 결함으로 체감', () => {
  const { sherpaPaceComp, rubatoActive, RUBATO_MAX_RATE } = require('../tts/sherpa/rate');
  test('rubatoActive: ≤2× 만 참(미지정 배속은 1× 취급 = 참)', () => {
    expect(rubatoActive(1)).toBe(true);
    expect(rubatoActive(RUBATO_MAX_RATE)).toBe(true);
    expect(rubatoActive(2.1)).toBe(false);
    expect(rubatoActive(2.5)).toBe(false);
    expect(rubatoActive(undefined)).toBe(true);
  });
  test('2.5×: 루바토 제외, 템포 평준화(짧은 문장 과속 보정)는 유지', () => {
    expect(sherpaPaceComp(0.92, 0.9, { rate: 2.5, rubatoOn: true })).toBeCloseTo(0.92, 6);
  });
  test('2×까지는 종전대로 루바토 적용', () => {
    expect(sherpaPaceComp(1, 0.9, { rate: 2, rubatoOn: true })).toBeCloseTo(0.9, 6);
  });
});
