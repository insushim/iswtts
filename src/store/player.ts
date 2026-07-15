import { create } from 'zustand';
import type { TtsEngine } from '../tts/TtsEngine';
import { getEngine, systemEngine } from '../tts';
import { EDGE_MAX_RATE } from '../tts/edge/rate';
import { SHERPA_QUALITY_MAX } from '../tts/sherpa/rate';
import { sherpaStats, resetSherpaStats } from '../tts/sherpa/stats';
import { contrastEdgeVoice } from '../tts/edge/voices';
import { splitDialogue, type DialogueSegment } from '../lib/dialogue';
import { useSettings } from './settings';
import { useLibrary } from './library';
import {
  startMediaSession,
  pauseMediaSession,
  stopMediaSession,
  setRemoteHandlers,
} from '../lib/mediaSession';

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
// 자동 대비(Edge=여↔남, sherpa=기본 화자+1, 시스템=같은 음성+피치 대비).
function speakParams(engineId: string, dialogue = false) {
  const s = useSettings.getState();
  const base = {
    rate: s.rate,
    pitch: s.pitch,
    language: s.language,
    voiceId:
      engineId === 'edge' ? s.edgeVoiceId
      : engineId === 'sherpa' ? s.sherpaVoiceId
      : s.voiceId,
  };
  if (!dialogue) return base;
  if (engineId === 'edge') {
    return { ...base, voiceId: s.edgeDialogueVoiceId || contrastEdgeVoice(base.voiceId, s.language) };
  }
  if (engineId === 'sherpa') {
    // sid 는 0~9 만 유효 — 저장소 손상/구버전 값은 자동 대비로 폴백.
    if (s.sherpaDialogueVoiceId && /^[0-9]$/.test(s.sherpaDialogueVoiceId)) {
      return { ...base, voiceId: s.sherpaDialogueVoiceId };
    }
    const parsed = Number.parseInt(base.voiceId || '0', 10);
    const baseSid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? parsed : 0;
    return { ...base, voiceId: String((baseSid + 1) % 10) };
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

// Edge 2× 초과 자동 전환 안내는 앱 실행당 1회만(문장마다 배너가 뜨면 소음).
let highSpeedNoticeShown = false;
let slowDeviceNoticeShown = false;

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
  const speakCurrent = () => {
    const { sentences, index, docId } = get();
    if (!sentences.length || index < 0 || index >= sentences.length) return;

    // 서킷 열림(연속 실패 백오프) 중엔 해당 엔진을 건너뛰고 시스템으로 — 백오프가 끝나면 자동 재시도.
    const settings = useSettings.getState();
    const wantId = settings.engineId;
    let engineId =
      wantId !== 'system' && Date.now() < (engineBlockedUntil[wantId] || 0) ? 'system' : wantId;
    // 설정 배속은 어느 엔진이든 그대로 적용된다(상한 없음 — 사용자 방침 2026-07-06).
    // 이 옵션은 품질 무손상 임계(Edge=2×, sherpa=3.2× — CER 실측) 초과 시 더 또렷한
    // 시스템 TTS 로 바꿔 듣고 싶은 사용자를 위한 선택지일 뿐이다.
    const qualityMax = engineId === 'edge' ? EDGE_MAX_RATE : engineId === 'sherpa' ? SHERPA_QUALITY_MAX : Infinity;
    if (settings.rate > qualityMax && settings.highSpeedSystemVoice) {
      engineId = 'system';
      if (!highSpeedNoticeShown) {
        highSpeedNoticeShown = true;
        set({ notice: '설정에 따라 고배속은 기본 음성으로 낭독합니다.' });
      }
    }
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
        set({ index: st.index + 1 });
        speakCurrent();
      } else {
        set({ playing: false, wordStart: 0, wordLen: 0 });
        pauseMediaSession(); // 책 끝 — 알림은 남겨 ▶ 로 재청취 가능
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
      eng.speak(seg.text, speakParams(engId, seg.dialogue), {
        ...handlers,
        onError: () => {
          if (myEpoch !== epoch) return;
          // 비-시스템 엔진(Edge/sherpa) 실패 시 → 같은 세그먼트를 시스템 TTS로 폴백해 낭독이 끊기지 않게.
          if (engId !== 'system') {
            // 연속 실패 집계 — 한도 도달 시 잠시 해당 엔진을 차단하고 사용자에게 1회 알림.
            if (reportEngineFailure(engId)) {
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
            systemEngine.speak(seg.text, speakParams('system', seg.dialogue), {
              ...handlers,
              onError: () => {
                if (myEpoch !== epoch) return;
                set({ playing: false, notice: '재생에 실패했습니다 — 기기 TTS 설정을 확인해주세요.' });
                pauseMediaSession();
              },
            });
            return;
          }
          set({ playing: false, notice: '재생에 실패했습니다 — 기기 TTS 설정을 확인해주세요.' });
          pauseMediaSession();
        },
      });

      // 다음 발화 단위들을 미리 합성(문장 간·세그먼트 간 딜레이 제거). 시스템 엔진은 no-op.
      // 깊이는 engine.prefetchUnits(엔진별) — 상한은 엔진 캐시(MAX_CACHE)가 관리.
      // 기기가 이 배속의 실시간 합성을 못 따라가면(버퍼를 깊게 잡아도 계속 마름) 그건 코드로
      // 못 고치는 성능 한계다 — 추측하게 두지 말고 사용자에게 선택지를 알린다(앱 실행당 1회).
      if (!fellBack && engineId === 'sherpa') maybeWarnSlowDevice(settings.rate);

      if (!fellBack) {
        const depth = engine.prefetchUnits ?? DEFAULT_PREFETCH_UNITS;
        const upcoming: DialogueSegment[] = [];
        for (let k = si + 1; k < segs.length && upcoming.length < depth; k++) {
          upcoming.push(segs[k]);
        }
        for (let n = index + 1; n < sentences.length && upcoming.length < depth; n++) {
          const nsegs = allSegs?.[n] ?? [{ text: sentences[n], start: 0, dialogue: false }];
          for (let k = 0; k < nsegs.length && upcoming.length < depth; k++) {
            upcoming.push(nsegs[k]);
          }
        }
        for (const u of upcoming) engine.prefetch?.(u.text, speakParams(engineId, u.dialogue));
      }
    };
    speakSegment(0);
  };

  return {
    docId: null,
    title: '',
    sentences: [],
    index: 0,
    wordStart: 0,
    wordLen: 0,
    playing: false,
    notice: null,
    setNotice: (msg) => set({ notice: msg }),

    load: ({ docId, title, sentences, startIndex = 0 }) => {
      activeEngine.stop();
      epoch++;
      // 진단은 "지금 읽는 이 책"의 것이어야 한다 — 앱을 켠 이후 평생 누적이면 오래된 표본이
      // 현재 기기 상태를 희석한다(교차검증 지적 2026-07-13). 느린 기기 안내도 다시 무장.
      resetSherpaStats();
      slowDeviceNoticeShown = false;
      pauseMediaSession(); // 새 문서 준비 — 앵커도 정지 상태로 정렬(재생 시 새 제목으로 재개)
      set({
        docId,
        title,
        sentences,
        index: Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1))),
        wordStart: 0,
        wordLen: 0,
        playing: false,
        notice: null, // 이전 문서의 알림이 새 문서에 남지 않게
      });
    },

    play: () => {
      if (!get().sentences.length) return;
      speakCurrent();
    },

    pause: () => {
      epoch++; // 진행 중 콜백 무효화
      activeEngine.stop();
      set({ playing: false });
      pauseMediaSession();
    },

    toggle: () => {
      if (get().playing) get().pause();
      else get().play();
    },

    next: () => {
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
      // 고배속 시스템 전환 옵션이 켜져 있으면, 새 배속이 품질임계를 넘나들 때 발화 엔진
      // 자체가 바뀌어야 한다(speakCurrent 의 전환 로직) — 라이브 적용으로 건너뛰면 그
      // 문장만 설정이 무시된다(교차검증 발견 2026-07-08). 이 경우 재발화 경로로.
      const s = useSettings.getState();
      if (s.highSpeedSystemVoice) {
        const wantMax =
          s.engineId === 'edge' ? EDGE_MAX_RATE : s.engineId === 'sherpa' ? SHERPA_QUALITY_MAX : Infinity;
        const shouldBeSystem = rate > wantMax;
        if (shouldBeSystem !== (activeEngine === systemEngine)) {
          get().seek(get().index);
          return;
        }
      }
      // 현재 울리는 문장에 라이브 적용을 시도 — 성공하면 재합성·침묵 없이 즉시 새 속도.
      // (sherpa 1×~3× 구간, Edge 는 SSML 몫이 같은 구간(2×↔2.5×↔3×…)에서 성공.)
      if (activeEngine.setRate?.(rate)) return;
      // 불가(합성 파라미터가 달라짐) — 현재 문장을 새 배속으로 재발화.
      get().seek(get().index);
    },

    seek: (i) => {
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
      epoch++;
      activeEngine.stop();
      stopMediaSession(); // 잠금화면 알림까지 제거
      // 대사 세그먼트 캐시 정리(닫은 문서의 문장 배열을 붙들지 않게).
      segCacheSrc = null;
      segCache = [];
      set({
        docId: null,
        title: '',
        sentences: [],
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
    else pauseMediaSession(); // 읽을 문서가 없으면 앵커만 되돌림
  },
  onRemotePause: () => {
    const st = usePlayer.getState();
    if (st.playing) st.pause();
  },
});
