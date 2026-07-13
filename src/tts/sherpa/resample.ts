// 합성 오디오 2:1 다운샘플(44.1kHz → 22.05kHz) — 순수 함수.
//
// 왜(2026-07-14 사용자 보고 "배터리를 엄청 먹는다" + 진단상 마름·끊김이 둘 다 조금씩):
// Supertonic 은 44.1kHz 로 출력하는데(대부분의 신경망 TTS 는 22.05kHz 가 표준), 이 앱에서
// 그 샘플은 문장마다 다음을 전부 통과한다 — JS 배열로 브릿지를 건너오고(문장당 25만 개),
// 무음 분석·정렬로 순회되고, 다시 브릿지를 건너 WAV 로 저장되고, 재생 시 디코딩되고,
// 배속 재생이면 Sonic 스트레치까지 거친다. 샘플을 절반으로 줄이면 이 사슬 전체가 절반이 된다.
// 마름(합성이 재생을 못 따라감)·끊김(재생 언더런)·배터리가 같은 뿌리(CPU 과다)라 함께 준다.
//
// 품질: 로컬 실측(실제 Supertonic 합성 + Whisper 전사, 5문장 × 1.5배속) CER 44.1kHz 0.0% →
// 22.05kHz 0.0%. 명료도 손실 0. 나이퀴스트 11kHz 로 음성 대역을 충분히 덮는다.
//
// 필터: 2:1 추출 전 3탭 저역통과([0.25, 0.5, 0.25])로 에일리어싱을 눌러준다. 실측상 필터
// 없이(naive) 뽑아도 CER 은 같았지만, 그건 Whisper 가 못 듣는 것일 뿐 고역 에일리어싱은
// 청감상 거칠기로 남을 수 있어 값싼 필터를 남긴다(샘플당 곱셈 3회 — 이후 절반이 되는 모든
// 단계의 절감에 비하면 무시할 수준).

/** 2:1 다운샘플. 길이가 2 미만이면 원본을 그대로 돌려준다(필터가 의미 없음). */
export function downsampleHalf(samples: ArrayLike<number>): number[] {
  const n = samples.length;
  if (n < 2) return Array.from(samples);
  const outLen = n >> 1;
  const out = new Array<number>(outLen);
  for (let i = 0; i < outLen; i++) {
    const j = i << 1;
    const a = j > 0 ? samples[j - 1] : samples[j];
    const b = samples[j];
    const c = j + 1 < n ? samples[j + 1] : samples[j];
    out[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  return out;
}

// 다운샘플이 이득인 하한. 이보다 낮은 출력(이미 22.05kHz 이하인 모델로 교체되는 경우)까지
// 반으로 깎으면 음질이 실제로 상한다 — 44.1kHz 급 출력에만 적용한다.
const MIN_RATE_TO_HALVE = 32_000;

export function shouldHalve(sampleRate: number): boolean {
  return Number.isFinite(sampleRate) && sampleRate >= MIN_RATE_TO_HALVE;
}
