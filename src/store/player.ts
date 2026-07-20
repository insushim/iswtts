import { create } from 'zustand';
import type { TtsEngine } from '../tts/TtsEngine';
import { getEngine, systemEngine } from '../tts';
import { sherpaStats, resetSherpaStats } from '../tts/sherpa/stats';
import { sherpaModelSpeed, sherpaTrimEnabled, sherpaRubato } from '../tts/sherpa/rate';
import { contrastEdgeVoice, genderEdgeVoice } from '../tts/edge/voices';
import { splitDialogue, type DialogueSegment } from '../lib/dialogue';
import {
  guessDialogueGenders,
  SHERPA_FEMALE_SIDS,
  SHERPA_MALE_SIDS,
  type SpeakerGender,
} from '../lib/speakerGender';
import { useSettings } from './settings';
import { useLibrary } from './library';
import {
  startMediaSession,
  stopMediaSession,
  setRemoteHandlers,
} from '../lib/mediaSession';
import { promptBgReliabilityOnce } from '../lib/batteryOpt';
import { sentenceGapMs } from '../lib/pacing';
import { playGap, GAP_MIN_MS } from '../lib/gapPlayer';
import { startBgSound } from '../lib/bgSound';

// 재생 컨트롤러. 문장 큐를 순회하며 엔진에 발화시키고, onBoundary로 단어 하이라이트를 갱신한다.
// epoch로 stale 콜백(정지/문장전환 후 뒤늦게 온 콜백)을 무효화한다.
let epoch = 0;

// 현재 발화 중인 엔진(정지/문장전환 시 이 엔진을 멈춘다). 엔진 전환 시에도 올바른 엔진을 stop.
let activeEngine: TtsEngine = systemEngine;

// 엔진 서킷브레이커(비-시스템 엔진 공용): 연속 실패가 쌓이면 일정 시간 그 엔진 시도를 건너뛴다.
// (없으면 장애 시 문장마다 타임아웃/합성 실패를 기다린 뒤에야 폴백 — 낭독이 뚝뚝 끊긴다.)
const ENGINE_FAIL_LIMIT = 3;
const ENGINE_BLOCK_MS = 60_000;
const engineFails: Record<string, number> = {};
const engineBlockedUntil: Record<string, number> = {};

function reportEngineFailure(id: string): boolean {
  engineFails[id] = (engineFails[id] || 0) + 1;
  if (engineFails[id] >= ENGINE_FAIL_LIMIT) {
    engineFails[id] = 0;
    engineBlockedUntil[id] = Date.now() + ENGINE_BLOCK_MS;
    return true; // 방금 차단이 발동됨(사용자 알림용)
  }
  return false;
}

// 설정에서 엔진을 다시 고르는 등 사용자가 명시적으로 재시도할 때 호출.
export function resetEngineCircuit(id?: string) {
  if (id) {
    engineFails[id] = 0;
    engineBlockedUntil[id] = 0;
    return;
  }
  for (const k of Object.keys(engineBlockedUntil)) engineBlockedUntil[k] = 0;
  for (const k of Object.keys(engineFails)) engineFails[k] = 0;
}

export type PlayerState = {
  docId: string | null;
  title: string;
  sentences: string[];
  // 문단을 새로 시작하는 문장 인덱스(낭독 페이스 — pacing.ts 문단 호흡). 구문서는 빈 Set.
  paraStarts: Set<number>;
  index: number;
  wordStart: number;
  wordLen: number;
  playing: boolean;
  // 사용자에게 보여줄 일시적 알림(재생 실패·폴백 전환 등). PlayerScreen이 배너로 표시 후 지운다.
  notice: string | null;
  setNotice: (msg: string | null) => void;

  load: (args: {
    docId: string;
    title: string;
    sentences: string[];
    paraStarts?: number[];
    startIndex?: number;
  }) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (index: number) => void;
  // 재생 중 배속 변경 반영: 엔진이 라이브 적용 가능하면 끊김 0, 아니면 현재 문장 재발화.
  applyRate: (rate: number) => void;
  unload: () => void;
};

// 엔진마다 음성 식별자 체계가 다르다 → "실제 발화할 엔진"(자동 전환 반영) 기준으로 voiceId 전달.
// dialogue=true 면 대사 음성으로 교체(멀티보이스): 사용자가 고른 대사 음성 우선, 미지정 시
// 자동 대비. v1.25.1: 지문의 성별 단서(speakerGender.ts — "그가 말했다"/"어머니가 …")로
// 남/여 음성을 맞춰 고른다(Edge=성별 라벨, sherpa=실측 성별 sid). 단서 없으면 종전 중립
// 대비(Edge=여↔남, sherpa=기본 화자+1, 시스템=같은 음성+피치 대비).
// ⚠️ gender 는 재생·prefetch·워밍업 세 경로 모두 같은 문장이면 같은 값이어야 한다(다르면
// 캐시 키가 갈려 프리페치가 헛돈다) — 항상 gendersOf(sentences)[n] 로만 얻을 것.
function speakParams(engineId: string, dialogue = false, gender: SpeakerGender | null = null) {
  const s = useSettings.getState();
  const base = {
    rate: s.rate,
    pitch: s.pitch,
    language: s.language,
    breath: engineId === 'sherpa' && s.breathSound,
    rubato: engineId === 'sherpa' && s.rubato,
    voiceId:
      engineId === 'edge' ? s.edgeVoiceId
      : engineId === 'sherpa' ? s.sherpaVoiceId
      : s.voiceId,
  };
  if (!dialogue) return base;
  if (engineId === 'edge') {
    const auto = gender
      ? genderEdgeVoice(gender, base.voiceId, s.language)
      : contrastEdgeVoice(base.voiceId, s.language);
    return { ...base, voiceId: s.edgeDialogueVoiceId || auto };
  }
  if (engineId === 'sherpa') {
    // sid 는 0~9 만 유효 — 저장소 손상/구버전 값은 자동 대비로 폴백.
    if (s.sherpaDialogueVoiceId && /^[0-9]$/.test(s.sherpaDialogueVoiceId)) {
      return { ...base, voiceId: s.sherpaDialogueVoiceId };
    }
    const parsed = Number.parseInt(base.voiceId || '0', 10);
    const baseSid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? parsed : 0;
    // 성별 미상 폴백도 "반대 성별"로(v1.25.3): 구 +1 대비는 기본 화자가 여성(sid 0)일 때
    // 폴백도 여성(sid 1)이라, 단서 없는 남성 대사(이름 꼬리표·연속 대화)가 전부 여성으로
    // 들렸다(사용자 보고 "남녀 구분이 잘 안 된다"). 지문은 기본 화자가 읽으니 대사 미상은
    // 반대 성별이 대비도 살리고 주연(이성 상대역) 적중률도 높다.
    const pool = gender
      ? gender === 'male'
        ? SHERPA_MALE_SIDS
        : SHERPA_FEMALE_SIDS
      : baseSid <= 4
        ? SHERPA_MALE_SIDS
        : SHERPA_FEMALE_SIDS;
    const pick = pool.find((sid) => sid !== String(baseSid)) ?? pool[0];
    return { ...base, voiceId: pick };
  }
  if (s.dialogueVoiceId) return { ...base, voiceId: s.dialogueVoiceId };
  return { ...base, pitch: Math.min(2, base.pitch * 1.25) };
}

// 대사 세그먼트는 문서 단위로 1회 계산(문장 경계를 넘는 따옴표 추적) — 배열 참조로 메모.
let segCacheSrc: string[] | null = null;
let segCache: DialogueSegment[][] = [];
function segsOf(sentences: string[]): DialogueSegment[][] {
  if (segCacheSrc !== sentences) {
    segCacheSrc = sentences;
    segCache = splitDialogue(sentences);
  }
  return segCache;
}

// 문장별 대사 화자 성별(지문 단서 추정) — segsOf 와 같은 문서 단위 메모. 재생·prefetch·
// 워밍업이 전부 이 값을 쓰므로 세 경로의 캐시 키가 항상 일치한다(speakParams 경고 참조).
let genderCacheSrc: string[] | null = null;
let genderCache: (SpeakerGender | null)[] = [];
function gendersOf(sentences: string[]): (SpeakerGender | null)[] {
  if (genderCacheSrc !== sentences) {
    genderCacheSrc = sentences;
    // 2패스(문서 단위): 대사만 있는 문장은 앞뒤 지문 문장의 단서까지 본다(v1.25.3).
    genderCache = guessDialogueGenders(sentences);
  }
  return genderCache;
}

// 세그먼트의 대사 성별 인자 — speakParams 에 넘길 값의 단일 계산 경로(재생·폴백·prefetch·
// 워밍업 4곳이 공유 — 한 곳만 고쳐지는 사고 방지, 교차검증 지적).
function genderFor(
  sentences: string[],
  dialogue: boolean,
  sentenceIndex: number,
): SpeakerGender | null {
  return dialogue ? gendersOf(sentences)[sentenceIndex] : null;
}

// fromSentence 문장의 fromSeg 세그먼트부터 depth 개의 발화 유닛을 순서대로 수집.
// 재생 중 prefetch 와 로드 시 워밍업이 이 순회를 공유한다 — 같은 로직이 두 곳에 갈라져
// 한쪽만 고쳐지는 사고 방지(교차검증 지적 2026-07-18).
function collectUpcoming(
  sentences: string[],
  allSegs: DialogueSegment[][] | null,
  fromSentence: number,
  fromSeg: number,
  depth: number,
): Array<DialogueSegment & { sentence: number }> {
  const upcoming: Array<DialogueSegment & { sentence: number }> = [];
  for (let n = fromSentence; n < sentences.length && upcoming.length < depth; n++) {
    const nsegs = allSegs?.[n] ?? [{ text: sentences[n], start: 0, dialogue: false }];
    for (let k = n === fromSentence ? fromSeg : 0; k < nsegs.length && upcoming.length < depth; k++) {
      upcoming.push({ ...nsegs[k], sentence: n }); // 성별 조회(gendersOf)용 문장 인덱스 동반
    }
  }
  return upcoming;
}

let slowDeviceNoticeShown = false;

// sherpa 선행합성 큐가 마지막으로 적재된 배속 — 근사 라이브 변경으로 다른 합성 구간의 큐를
// 깔았다가 원래 구간으로 되돌아오는 경우(4×→5×→4×)의 스테일 큐 판정용(교차검증 2026-07-18).
let sherpaQueueRate = 1;

// 오프라인 합성이 재생 소비를 못 따라가는 상태의 판정(기기 실측 기반 — stats.ts).
// 조건: 표본이 쌓였고(합성 5건+), 발화 시작 대기가 반복됐고(3회+), 측정된 합성 RTF × 설정
// 배속이 실시간 예산(1.0)에 붙었다 = 버퍼를 깊게 잡아도 정상상태에서 결국 마른다.
function maybeWarnSlowDevice(rate: number): void {
  if (slowDeviceNoticeShown || rate <= 1) return;
  const st = sherpaStats();
  if (st.synths < 5 || st.starved < 3) return;
  if (st.avgRtf * rate < 0.9) return;
  slowDeviceNoticeShown = true;
  usePlayer.setState({
    notice: `이 기기는 ${rate}배속의 오프라인 음성 합성을 실시간으로 따라가지 못해 낭독이 끊길 수 있습니다 — 배속을 낮추거나 설정에서 온라인/기본 음성을 사용해 보세요.`,
  });
}

// 선행 합성 깊이는 엔진이 자기 특성에 맞게 정한다(TtsEngine.prefetchUnits) — 오프라인은 깊게
// (CPU 지터 흡수), 온라인은 얕게(연결 낭비 방지). 각 엔진 캐시 상한(MAX_CACHE)보다 작아야
// 재생 중 유닛 + 선행분이 캐시에서 서로를 밀어내지 않는다. 미지정 엔진은 보수적 기본(3).
const DEFAULT_PREFETCH_UNITS = 3;

export const usePlayer = create<PlayerState>((set, get) => {
  // 문장 사이 "쉼"(pacing.ts) 진행 상태. 쉼은 무음 재생(gapPlayer)으로 구현 — JS 타이머는
  // 화면 꺼짐/백그라운드에서 얼어붙어 낭독이 멈춘다(v1.23.0 회귀 실측 2026-07-19).
  // 쉼 동안 index 는 이전 문장에 남긴다(하이라이트 조기 점프 방지). 대신 여기 nextIndex 를
  // 들고 있다가 일시정지/이탈 시 확정해, 재개가 "다 들은 문장 반복"이 되는 레이스를 막는다
  // (교차검증 CRITICAL 2026-07-18).
  let pendingGap: { cancel: () => void; nextIndex: number } | null = null;
  const clearPendingGap = (commit: boolean) => {
    if (!pendingGap) return;
    const { cancel, nextIndex } = pendingGap;
    pendingGap = null;
    cancel();
    if (commit) {
      set({ index: nextIndex, wordStart: 0, wordLen: 0 });
      const { docId, sentences } = get();
      if (docId) useLibrary.getState().setProgress(docId, nextIndex, sentences.length);
    }
  };

  const speakCurrent = () => {
    clearPendingGap(false); // 새 발화가 예약된 쉼을 대체(수동 이동·재발화 등)
    const { sentences, index, docId } = get();
    if (!sentences.length || index < 0 || index >= sentences.length) return;

    // 서킷 열림(연속 실패 백오프) 중엔 해당 엔진을 건너뛰고 시스템으로 — 백오프가 끝나면 자동 재시도.
    const settings = useSettings.getState();
    const wantId = settings.engineId;
    const engineId =
      wantId !== 'system' && Date.now() < (engineBlockedUntil[wantId] || 0) ? 'system' : wantId;
    // 설정 배속은 어느 엔진이든 그대로 적용된다(상한 없음 — 사용자 방침 2026-07-06). 고배속에서도
    // 선택한 음성(오프라인 고품질 등)을 그대로 유지한다 — 예전의 "3× 초과 시 기본 음성 강제 전환"은
    // 사용자 지시로 폐지(2026-07-16): 재생 중 배속을 오르내릴 때 엔진이 바뀌며 재합성 큐가 꼬여
    // 낭독이 멈추는 원인이었고, 사용자는 빠른 속도에서도 오프라인 목소리를 원한다.
    const engine = getEngine(engineId);
    // 엔진 전환 시에만 이전 엔진을 완전 정지(그 엔진의 prefetch 캐시까지 비움).
    // 같은 엔진이면 stop()을 부르지 않는다 — engine.speak()가 현재 재생만 끊고 prefetch 캐시는 보존해,
    // 자동진행 시 미리 합성해 둔 다음 문장이 즉시 재생된다(문장 간 딜레이 제거의 핵심).
    if (activeEngine !== engine) activeEngine.stop();
    activeEngine = engine;
    const myEpoch = ++epoch;
    set({ wordStart: 0, wordLen: 0, playing: true });
    // 백그라운드 유지 + 잠금화면 컨트롤(무음 앵커). 문장마다 불려도 무해(멱등).
    startMediaSession(get().title);
    // 432Hz 배경 앰비언트(선택형) — 켜져 있으면 낭독 뒤에 은은히 깔린다(멱등). 정지는
    // stopMediaSession 에 중앙화돼 모든 정지 경로에서 함께 멈춘다.
    if (settings.bgSound) startBgSound(settings.bgVolume);

    // 진행률 저장
    if (docId) useLibrary.getState().setProgress(docId, index, sentences.length);

    // 문장 → 발화 세그먼트(대사 멀티보이스가 켜져 있으면 지문/대사 분리, 꺼져 있으면 문장 통째).
    const sentence = sentences[index];
    const allSegs = settings.dialogueVoice ? segsOf(sentences) : null;
    const segs: DialogueSegment[] =
      allSegs?.[index] ?? [{ text: sentence, start: 0, dialogue: false }];

    // 이 문장에서 시스템 폴백이 발생하면 남은 세그먼트도 시스템으로(실패 엔진 재시도 소음 방지).
    let fellBack = false;

    const advanceSentence = () => {
      // 폴백 없이 문장을 완주했을 때만 연속 실패 카운터 리셋(문장 단위 의미 유지).
      // 세그먼트 성공마다 리셋하면 "지문 성공 + 대사 실패" 문장에서 카운터가 매번 0으로
      // 돌아가 서킷브레이커가 영원히 안 열린다 — 교차검증 발견 2026-07-06.
      if (!fellBack && engineId !== 'system') engineFails[engineId] = 0;
      const st = get();
      if (st.index < st.sentences.length - 1) {
        const nextIndex = st.index + 1;
        // 낭독 페이스 자연화(pacing.ts): 자동진행에만 문맥 비례 쉼을 얹는다 — 문단 전환·
        // 말줄임·대화문 beat·긴 문장 회복 + 미세 변주. 고품질 오프라인(sherpa) 낭독 전용
        // (다른 엔진은 자체 발화 텀이 이미 김). 수동 넘김(next/prev/seek)은 즉시 반응 유지.
        const cfg = useSettings.getState();
        const gap =
          !fellBack && engineId === 'sherpa'
            ? sentenceGapMs(st.sentences[st.index], st.sentences[nextIndex], {
                paragraphBreak: st.paraStarts.has(nextIndex),
                rate: cfg.rate,
                // 완급 변주로 느긋하게 읽은 문장 뒤엔 숨 고르기 한 번 추가(pacing.ts
                // RUBATO_REST). 판정은 방금 끝난 문장 전체를 엔진과 같은 순수 함수
                // (sherpaRubato)에 넣어 계산 — 대사 분할 문장은 엔진이 세그먼트 단위로
                // 해시해 판정이 어긋날 수 있으나 영향은 쉼 ±60ms 뿐(감속 자체와 무관).
                afterRubato: cfg.rubato && sherpaRubato(st.sentences[st.index]) !== 1,
              })
            : 0;
        if (gap < GAP_MIN_MS) {
          set({ index: nextIndex, wordStart: 0, wordLen: 0 });
          speakCurrent();
        } else {
          // 무음 재생으로 쉼(gapPlayer 주석 참조 — setTimeout 금지). 쉼 동안의 정지/이탈/
          // 수동 이동은 pendingGap 정리 + epoch 로 무효화.
          // 문단 들숨(v1.26.0): 숨소리 옵션이 켜져 있으면 문단 전환 쉼의 무음 일부를 합성
          // 들숨으로 채운다(gapPlayer 주석) — 사람 낭독자의 "새 문단 앞 큰 숨". 쉼 길이가
          // 충분할 때만 실효(고배속 자동 제외)라 여기선 문단 여부만 넘긴다.
          const cancel = playGap(
            gap,
            () => {
              pendingGap = null;
              if (myEpoch !== epoch) return;
              set({ index: nextIndex, wordStart: 0, wordLen: 0 });
              speakCurrent();
            },
            { breath: cfg.breathSound && st.paraStarts.has(nextIndex) },
          );
          pendingGap = { cancel, nextIndex };
        }
      } else {
        // 책 끝 = 완전 종료. 재생 엔진과 미디어 세션을 모두 내린다. 앵커(무음 루프)만 멈추면
        // setActiveForLockScreen(true) 로 등록된 mediaPlayback 포그라운드
        // 서비스가 계속 살아 있어, 아무것도 재생하지 않는데도 OS 가 앱을 동결/도즈하지 못해 배터리를
        // 계속 먹는다(사용자 보고 2026-07-16 "끝까지 가도 전기를 엄청 먹는 느낌"). stopMediaSession
        // 으로 포그라운드 서비스·잠금화면 알림을 내려 앱이 동결될 수 있게 한다. 재청취는 ▶(앱 내)로
        // 다시 시작하면 세션이 재등록된다. activeEngine.stop() 은 선행합성 캐시·오디오 자원까지 정리.
        activeEngine.stop();
        set({ playing: false, wordStart: 0, wordLen: 0 });
        stopMediaSession();
      }
    };

    const speakSegment = (si: number) => {
      const seg = segs[si];
      const engId = fellBack ? 'system' : engineId;
      const eng = fellBack ? systemEngine : engine;
      const handlers = {
        // 세그먼트 내 오프셋 → 문장 내 오프셋(하이라이트는 문장 기준).
        onBoundary: (charIndex: number, charLength: number) => {
          if (myEpoch !== epoch) return;
          set({ wordStart: seg.start + charIndex, wordLen: charLength });
        },
        onDone: () => {
          if (myEpoch !== epoch) return;
          if (si < segs.length - 1) speakSegment(si + 1);
          else advanceSentence();
        },
      };
      eng.speak(seg.text, speakParams(engId, seg.dialogue, genderFor(sentences, seg.dialogue, index)), {
        ...handlers,
        onError: (err?: Error) => {
          if (myEpoch !== epoch) return;
          // 비-시스템 엔진(Edge/sherpa) 실패 시 → 같은 세그먼트를 시스템 TTS로 폴백해 낭독이 끊기지 않게.
          if (engId !== 'system') {
            // 모델 미설치(앱 업데이트로 음성 데이터 위치가 바뀐 v1.19 마이그레이션 포함)는
            // "재생 문제"가 아니라 "다운로드 필요" — 뭘 해야 하는지 정확히 알려준다
            // (실측 2026-07-16: 안내 없이 조용히 기본 음성 폴백 → 사용자는 "고품질
            // 오프라인이 아예 안 된다"로 인지).
            const missingModel =
              engId === 'sherpa' && /설치되지 않았습니다/.test(String(err?.message ?? ''));
            // 연속 실패 집계 — 한도 도달 시 잠시 해당 엔진을 차단하고 사용자에게 1회 알림.
            const circuitOpened = reportEngineFailure(engId);
            if (missingModel) {
              set({
                notice:
                  '고품질 오프라인 음성 데이터가 아직 없습니다 — 설정에서 "음성 데이터 받기"(195MB)를 눌러 주세요. 지금은 기본 음성으로 읽어드립니다.',
              });
            } else if (circuitOpened) {
              set({
                notice:
                  engId === 'edge'
                    ? '온라인 음성 연결이 불안정해 잠시 기본 음성으로 낭독합니다.'
                    : '오프라인 고품질 음성 재생에 문제가 있어 잠시 기본 음성으로 낭독합니다.',
              });
            }
            eng.stop(); // 잔여 재생·prefetch 캐시(mp3/wav) 정리(폴백 후 누수 방지)
            activeEngine = systemEngine;
            fellBack = true;
            systemEngine.speak(seg.text, speakParams('system', seg.dialogue, genderFor(sentences, seg.dialogue, index)), {
              ...handlers,
              onError: () => {
                if (myEpoch !== epoch) return;
                set({ playing: false, notice: '재생에 실패했습니다 — 기기 TTS 설정을 확인해주세요.' });
                stopMediaSession();
              },
            });
            return;
          }
          set({ playing: false, notice: '재생에 실패했습니다 — 기기 TTS 설정을 확인해주세요.' });
          stopMediaSession();
        },
      });

      // 다음 발화 단위들을 미리 합성(문장 간·세그먼트 간 딜레이 제거). 시스템 엔진은 no-op.
      // 깊이는 engine.prefetchUnits(엔진별) — 상한은 엔진 캐시(MAX_CACHE)가 관리.
      // 기기가 이 배속의 실시간 합성을 못 따라가면(버퍼를 깊게 잡아도 계속 마름) 그건 코드로
      // 못 고치는 성능 한계다 — 추측하게 두지 말고 사용자에게 선택지를 알린다(앱 실행당 1회).
      if (!fellBack && engineId === 'sherpa') maybeWarnSlowDevice(settings.rate);

      if (!fellBack) {
        const depth = engine.prefetchUnits ?? DEFAULT_PREFETCH_UNITS;
        const upcoming = collectUpcoming(sentences, allSegs, index, si + 1, depth);
        for (const u of upcoming)
          engine.prefetch?.(
            u.text,
            speakParams(engineId, u.dialogue, genderFor(sentences, u.dialogue, u.sentence)),
          );
        if (engineId === 'sherpa') sherpaQueueRate = settings.rate;
      }
    };
    speakSegment(0);
  };

  // 문서를 연 순간부터 현재 위치의 앞 몇 문장을 미리 합성(오프라인 신경망 엔진만) —
  // 사용자가 ▶ 를 누르기 전 화면을 보는 몇 초가 공짜 워밍업 시간이다(2026-07-18 "좀더
  // 앞에서부터"). 효과 둘: ① ▶ 즉시 첫 문장 시작(현재 문장 포함이라 캐시 히트) ② 재생이
  // 여유 버퍼를 갖고 출발해 초반(버퍼가 아직 안 쌓인 구간)의 발화 대기 편차 = 리듬 흔들림이
  // 사라진다. 시스템 TTS 는 즉시 발화라 불필요, Edge(온라인)는 재생 의사 없이 연결을 여는
  // 낭비라 제외. 모델 미설치면 prefetch 가 조용히 실패(캐시에서 제거)할 뿐 부작용 없다.
  const WARMUP_UNITS = 8;
  // fromIndex 미지정 = 현재 문장부터(로드 시 워밍업). 배속 변경 시엔 index+1 부터(현재 문장은
  // 이미 재생 중이라 합성 불필요 — 괜히 넣으면 체인 맨 앞을 죽은 합성이 차지한다).
  const warmUp = (fromIndex?: number) => {
    const { sentences } = get();
    const index = fromIndex ?? get().index;
    if (!sentences.length || index >= sentences.length) return;
    const settings = useSettings.getState();
    const engineId = settings.engineId;
    if (engineId !== 'sherpa') return;
    if (Date.now() < (engineBlockedUntil[engineId] || 0)) return; // 서킷 열림 중엔 시도 안 함
    const engine = getEngine(engineId);
    if (!engine.prefetch) return;
    // ⚠️ 워밍업이 합성 큐를 쥐는 순간 이 엔진이 "파이프라인을 쥔 엔진"이다 — activeEngine 으로
    // 등록해야 load/pause 의 suspend·stop 이 이 큐를 정리할 수 있다. 안 하면 "문서 A 열기(재생
    // 안 함) → 목록 → 문서 B 열기 → ▶" 에서 A 의 미완료 워밍업이 어느 정지 경로에도 안 걸린 채
    // B 첫 문장 합성 앞을 막는 FIFO 클로그가 재현된다(교차검증 발견 2026-07-18).
    if (activeEngine !== engine) {
      activeEngine.stop();
      activeEngine = engine;
    }
    const allSegs = settings.dialogueVoice ? segsOf(sentences) : null;
    for (const u of collectUpcoming(sentences, allSegs, index, 0, WARMUP_UNITS)) {
      engine.prefetch(
        u.text,
        speakParams(engineId, u.dialogue, genderFor(sentences, u.dialogue, u.sentence)),
      );
    }
    sherpaQueueRate = settings.rate;
  };

  return {
    docId: null,
    title: '',
    sentences: [],
    paraStarts: new Set<number>(),
    index: 0,
    wordStart: 0,
    wordLen: 0,
    playing: false,
    notice: null,
    setNotice: (msg) => set({ notice: msg }),

    load: ({ docId, title, sentences, paraStarts, startIndex = 0 }) => {
      clearPendingGap(false); // 새 문서 — 이전 문서의 쉼 예약은 무효
      // suspend(지원 엔진): 같은 문서를 다시 열었을 때(이어듣기) 직전에 만들어 둔 선행합성이
      // 그대로 살아 즉시 이어진다. 다른 문서의 잔존 캐시는 키가 안 맞아 그냥 지나가고,
      // 워밍업·prefetch 가 새 항목을 넣으며 자연 축출된다(엔진 MAX_CACHE 상한).
      if (activeEngine.suspend) activeEngine.suspend();
      else activeEngine.stop();
      epoch++;
      // 진단은 "지금 읽는 이 책"의 것이어야 한다 — 앱을 켠 이후 평생 누적이면 오래된 표본이
      // 현재 기기 상태를 희석한다(교차검증 지적 2026-07-13). 느린 기기 안내도 다시 무장.
      resetSherpaStats();
      slowDeviceNoticeShown = false;
      stopMediaSession(); // 새 문서 준비 — 재생 전엔 FGS 를 들지 않는다(재생 시 새 제목으로 재등록)
      set({
        docId,
        title,
        sentences,
        paraStarts: new Set(paraStarts || []),
        index: Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1))),
        wordStart: 0,
        wordLen: 0,
        playing: false,
        notice: null, // 이전 문서의 알림이 새 문서에 남지 않게
      });
      // ▶ 를 누르기 전부터 현재 위치의 앞 문장들을 미리 합성해 둔다(오프라인 엔진만).
      warmUp();
    },

    play: () => {
      if (!get().sentences.length) return;
      // 첫 재생 시 1회: 배경(화면 꺼짐) 낭독이 배터리 관리에 끊기지 않도록 최적화 예외를 안내.
      promptBgReliabilityOnce();
      speakCurrent();
    },

    pause: () => {
      // 쉼(문장 사이 무음) 대기 중이었다면 다음 인덱스를 확정 — 재개가 다 들은 문장을
      // 반복하지 않고 다음 문장부터 이어진다.
      clearPendingGap(true);
      epoch++; // 진행 중 콜백 무효화
      // suspend(지원 엔진): 완료된 선행합성 버퍼를 보존한 채 정지 — 재개가 캐시 히트로 즉시
      // 시작되고, 정지 때마다 버퍼를 0에서 다시 쌓느라 생기던 초반 리듬 흔들림이 없어진다.
      // 미완료 합성은 취소된다(인플라이트 1건만 마저 돌고 폐기). 트레이드오프(의도): 화면
      // 이탈도 이 경로라 완료 WAV(상한 24개 ≈ 24MB)가 앱 프로세스 생존 동안 캐시 디렉토리에
      // 남는다 — OS 정리 가능 위치 + 다음 기동 시 sweepCache 청소라 수용(이어듣기 즉시 재개
      // 이득이 더 큼).
      if (activeEngine.suspend) activeEngine.suspend();
      else activeEngine.stop();
      set({ playing: false });
      // 일시정지 = 배터리도 쉬어야 한다(사용자 2026-07-16 "일시정지하면 배터리 안 먹는 게 낫지").
      // pauseMediaSession 은 앵커만 멈추고 mediaPlayback 포그라운드 서비스는 살려둬(잠금화면 재개
      // 알림 유지) OS 가 앱을 도즈하지 못해 전력을 계속 먹었다. stopMediaSession 으로 FGS·잠금화면
      // 알림까지 내려 정지 중엔 앱이 동결·절전될 수 있게 한다. 화면 이탈(언마운트)도 이 pause 를
      // 거치므로 목록으로 나가도 서비스가 잔존하지 않는다. 재개는 ▶(앱 내)로 세션 재등록.
      stopMediaSession();
    },

    toggle: () => {
      if (get().playing) get().pause();
      else get().play();
    },

    next: () => {
      clearPendingGap(false); // 수동 이동은 쉼을 취소(index 는 아래서 직접 지정)
      const { index, sentences, playing } = get();
      if (index >= sentences.length - 1) return;
      set({ index: index + 1, wordStart: 0, wordLen: 0 });
      if (playing) speakCurrent();
      else {
        const { docId } = get();
        if (docId) useLibrary.getState().setProgress(docId, index + 1, sentences.length);
      }
    },

    prev: () => {
      clearPendingGap(false);
      const { index, sentences, playing } = get();
      if (index <= 0) return;
      set({ index: index - 1, wordStart: 0, wordLen: 0 });
      if (playing) speakCurrent();
      else {
        const { docId } = get();
        if (docId) useLibrary.getState().setProgress(docId, index - 1, sentences.length);
      }
    },

    applyRate: (rate) => {
      if (!get().playing) return;
      // 문장 사이 쉼(pendingGap) 대기 중이면 먼저 다음 인덱스를 확정한다 — 안 하면 아래
      // ③ 재발화 폴백의 seek(get().index)가 "쉼 동안 이전 문장에 남겨 둔 index"를 타서
      // 방금 다 들은 문장을 반복 재생한다(교차검증 CRITICAL 2026-07-19: 쉼 중엔 엔진
      // player 가 이미 내려가 있어 ①②라이브가 항상 실패 → 반드시 ③으로 떨어짐).
      clearPendingGap(true);
      // ① 정확 라이브(합성 파라미터가 같은 구간): 끊김 0·품질 그대로 즉시 새 속도.
      //    (sherpa 1×~3× 구간, Edge 는 SSML 몫이 같은 구간(2×↔2.5×↔3×…)에서 성공.)
      if (activeEngine.setRate?.(rate)) {
        // 단, 직전 근사 변경이 다른 합성 구간의 큐를 깔아 둔 채 되돌아온 경우(4×→5×→4×)는
        // 그 큐의 키가 어긋난 스테일 — 미완료를 비우고 새 배속으로 다시 채운다(교차검증
        // 발견 2026-07-18: 안 하면 다음 문장에서 키 미스 + 발화 대기 재발).
        if (
          activeEngine.id === 'sherpa' &&
          (sherpaModelSpeed(sherpaQueueRate) !== sherpaModelSpeed(rate) ||
            sherpaTrimEnabled(sherpaQueueRate) !== sherpaTrimEnabled(rate))
        ) {
          activeEngine.cancelPending?.();
          warmUp(get().index + 1);
        }
        return;
      }
      // ② 근사 라이브(구간 경계를 넘음 — 3×↔4×+, 1×↔0.5×): 현재 문장 잔여를 근사 스트레치로
      //    "당장" 새 속도처럼 들리게 한다. 예전의 재발화 폴백은 재합성 침묵(실기기 수 초~수십
      //    초) + 문장 재시작이라 "배속을 바꿔도 안 바뀐다, 멈췄다 재생해야 바뀐다"로 체감됐다
      //    (사용자 보고 2026-07-18). 동시에 옛 배속의 미완료 큐를 비우고 다음 문장들을 새
      //    배속으로 지금부터 합성시켜, 문장 경계에서도 기다림이 없게 한다.
      if (activeEngine.setRateApprox?.(rate)) {
        activeEngine.cancelPending?.();
        warmUp(get().index + 1);
        return;
      }
      // ③ 라이브 수단이 없는 엔진(시스템 등): 현재 문장을 새 배속으로 재발화.
      get().seek(get().index);
    },

    seek: (i) => {
      clearPendingGap(false);
      const { sentences, playing } = get();
      const clamped = Math.max(0, Math.min(i, sentences.length - 1));
      set({ index: clamped, wordStart: 0, wordLen: 0 });
      if (playing) speakCurrent();
      else {
        // 정지 중 이동도 진행률 저장(next/prev와 동일 동작 — 일관성).
        const { docId } = get();
        if (docId) useLibrary.getState().setProgress(docId, clamped, sentences.length);
      }
    },

    unload: () => {
      clearPendingGap(false);
      epoch++;
      activeEngine.stop();
      stopMediaSession(); // 잠금화면 알림까지 제거
      // 대사 세그먼트·성별 캐시 정리(닫은 문서의 문장 배열을 붙들지 않게 — 둘은 항상 짝).
      segCacheSrc = null;
      segCache = [];
      genderCacheSrc = null;
      genderCache = [];
      set({
        docId: null,
        title: '',
        sentences: [],
        paraStarts: new Set<number>(),
        index: 0,
        wordStart: 0,
        wordLen: 0,
        playing: false,
      });
    },
  };
});

// 잠금화면/알림의 ▶·⏸ 는 네이티브가 앵커 플레이어를 직접 제어한다 — 그 상태 변화를
// 스토어의 play/pause 로 되비쳐 낭독(엔진)과 UI 를 함께 동기화한다.
setRemoteHandlers({
  onRemotePlay: () => {
    const st = usePlayer.getState();
    if (st.playing) return;
    if (st.sentences.length) st.play();
    else stopMediaSession(); // 읽을 문서가 없으면 세션·FGS 를 완전히 내린다
  },
  onRemotePause: () => {
    const st = usePlayer.getState();
    if (st.playing) st.pause();
  },
});
