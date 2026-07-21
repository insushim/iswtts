import { PermissionsAndroid, Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { buildSilenceWav } from './silenceWav';
import { stopBgSound } from './bgSound';

// 백그라운드 낭독 유지 + 잠금화면 컨트롤의 핵심: "세션 앵커" 플레이어.
//
// 문제: 소리책은 문장마다 오디오가 새로 시작되고(Edge) 시스템 엔진은 expo-audio 플레이어가
// 아예 없다. Android는 미디어 포그라운드 서비스가 없는 앱을 화면 꺼짐 후 수 분 내에
// 동결(cached-app freezer)해 JS의 "다음 문장 큐잉"이 멈춘다(실사용 1~3분 후 정지 증상).
//
// 해법: 무음 WAV를 루프 재생하는 앵커 플레이어 1개를 책 재생 내내 유지하고
// setActiveForLockScreen 으로 등록한다. 그러면 expo-audio 의 mediaPlayback 포그라운드
// 서비스가 살아 있어(=프로세스 동결 면제) 두 엔진 모두 화면이 꺼져도 낭독이 이어지고,
// 잠금화면·알림에 재생/일시정지 컨트롤이 생긴다.
//
// 잠금화면 버튼은 네이티브가 앵커 플레이어를 직접 play/pause 한다(JS 이벤트 없음).
// 앵커의 playbackStatusUpdate 와 "앱이 의도한 상태(desiredPlaying)"의 불일치가 잠시
// 유지되면 원격 조작으로 판정해 핸들러(스토어 play/pause)로 동기화한다. 즉시 판정하지
// 않는 이유: 시작 직후의 playing:false, 우리가 낸 pause 가 반영되기 전의 playing:true 같은
// 과도 상태가 스스로를 되돌리는 피드백 루프를 만들기 때문.

const SILENCE_FILE = 'anchor-silence.wav';
const SILENCE_SECONDS = 2;
// 원격 조작 확인 대기(ms). 짧을수록 알림창 ⏸ 반응이 빠르고, 문장 전환과 겹칠 확률도 준다
// (겹쳐도 resolvePendingRemote 가 구제하지만 창 자체를 좁히는 편이 낫다). 과도 상태
// (재생 직후의 playing:false 등)를 걸러낼 만큼은 남긴다.
const REMOTE_CONFIRM_MS = 200;

let anchor: AudioPlayer | null = null;
let sessionActive = false; // 잠금화면 등록 여부
let desiredPlaying = false; // 앱이 의도한 재생 상태(원격 조작 감지 기준)
// 이번 재생(desiredPlaying=true) 이후 앵커가 실제 재생에 도달했는지. 원격 "일시정지" 판정은
// 이 플래그가 참일 때만 — 콜드 스타트(파일 생성·서비스 바인딩)로 재생 도달이 늦어진 것을
// 원격 정지로 오판해 재생 직후 스스로 멈추는 race 차단. (재생에 도달한 적 없으면 잠금화면
// 버튼 자체가 노출되기 전이라 진짜 원격 정지일 수도 없다.)
let anchorReachedPlaying = false;
let lastTitle: string | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

type RemoteHandlers = { onRemotePlay: () => void; onRemotePause: () => void };
let handlers: RemoteHandlers | null = null;

export function setRemoteHandlers(h: RemoteHandlers): void {
  handlers = h;
}

// 앱 기동 시 1회. 백그라운드에서도 오디오 세션 유지 + 다른 앱 소리와 동시 재생(mixWithOthers
// 는 오디오 포커스를 아예 요청하지 않아 음악·영상 등 다른 미디어를 멈추지 않는다).
// ⚠️ expo-audio 문서의 "setActiveForLockScreen 사용 시 doNotMix 필수" 노트는 iOS 제약
// (MPRemoteCommandCenter가 non-mixable 세션 요구)이다 — Android 네이티브(AudioControlsService)는
// 포커스와 무관하게 동작함을 소스로 확인(2026-07-05). iOS 출시 시엔 여기 재검토 필요.
// 부작용: 포커스 미요청이라 전화 수신 중에도 낭독이 계속된다(동시재생 요구의 트레이드오프).
export async function configureAudioSession(): Promise<void> {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'mixWithOthers',
    });
  } catch {
    /* 미지원 플랫폼 — 기본 동작으로 진행 */
  }
}

function ensureSilenceUri(): string {
  const f = new File(Paths.document, SILENCE_FILE);
  const wav = buildSilenceWav(SILENCE_SECONDS);
  // 크기 불일치 = 과거 크래시로 잘린 파일 — 재생성(손상 WAV는 앵커 생성 자체를 깨뜨린다).
  if (f.exists && f.size !== wav.length) f.delete();
  if (!f.exists) {
    f.create();
    f.write(wav);
  }
  return f.uri;
}

// 마지막으로 관측한 앵커 재생 상태(네이티브 프로퍼티 읽기가 실패/지연될 때의 근거).
let lastObservedPlaying = false;

/**
 * 확인 대기 중인 불일치를 "지금" 판정한다(대기 만료를 기다리지 않고).
 * @returns 원격 조작으로 판정했으면 true.
 *
 * ⚠️ v1.27.0 급소: 이 즉시 판정이 없으면 알림창 ⏸ 가 통째로 무시된다. 낭독은 문장마다
 * startMediaSession → anchor.play() 를 부르는데, 사용자가 ⏸ 를 눌러 앵커가 멈춘 뒤
 * 확인 창(300ms) 안에 문장이 넘어가면 그 play() 가 앵커를 되살려 "불일치 해소"로 보이고
 * (onAnchorStatus 의 playing === desiredPlaying 분기) 타이머가 취소된다 — 정지 신호가
 * 사라지고 낭독은 계속된다. 사용자 보고 2026-07-21 "알림창 멈춤은 아예 안 되고 앱에
 * 들어가야 멈춘다". 그래서 startMediaSession 은 앵커를 다시 켜기 "전에" 이 함수를 부른다.
 */
function resolvePendingRemote(): boolean {
  if (!confirmTimer) return false;
  clearTimeout(confirmTimer);
  confirmTimer = null;
  if (!sessionActive || !anchor) return false;
  let now = lastObservedPlaying;
  try {
    now = anchor.playing;
  } catch {
    /* 네이티브 읽기 실패 — 마지막 관측값으로 판단 */
  }
  if (now === desiredPlaying) return false; // 과도 상태였음 — 무시
  if (now) {
    handlers?.onRemotePlay();
    return true;
  }
  if (anchorReachedPlaying) {
    handlers?.onRemotePause();
    return true;
  }
  return false;
}

function onAnchorStatus(playing: boolean): void {
  lastObservedPlaying = playing;
  if (playing) anchorReachedPlaying = true;
  if (playing === desiredPlaying) {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    return;
  }
  if (confirmTimer) return; // 이미 확인 대기 중
  confirmTimer = setTimeout(resolvePendingRemote, REMOTE_CONFIRM_MS);
}

function ensureAnchor(): AudioPlayer | null {
  if (anchor) return anchor;
  let p: AudioPlayer | null = null;
  try {
    p = createAudioPlayer(ensureSilenceUri());
    p.loop = true;
    p.volume = 0;
    p.addListener('playbackStatusUpdate', (st: any) => {
      if (!sessionActive || anchor !== p) return;
      onAnchorStatus(!!st?.playing);
    });
    anchor = p;
    return p;
  } catch {
    // 생성 후 설정 단계에서 실패하면 네이티브 인스턴스를 버리지 말고 해제(반복 시 누적 leak 방지).
    try {
      p?.remove();
    } catch {
      /* noop */
    }
    return null; // 앵커 실패 = 잠금화면/백그라운드 유지만 포기, 낭독 자체는 계속
  }
}

// Android 13+ 는 알림 표시에 런타임 권한이 필요하다(매니페스트 선언만으론 부족).
// 첫 재생 시 1회만 요청 — 거부해도 낭독·백그라운드 유지는 동작하고 알림 UI만 빠진다.
let notifRequested = false;
function requestNotificationPermission(): void {
  if (notifRequested) return;
  notifRequested = true;
  if (Platform.OS !== 'android' || (Platform.Version as number) < 33) return;
  PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {
    /* 요청 실패 = 미표시로 degrade */
  });
}

// 재생 시작·재개 시 호출(문장마다 불려도 무해 — 등록/메타데이터는 변화 있을 때만).
export function startMediaSession(title: string): void {
  const p = ensureAnchor();
  if (!p) return;
  // 대기 중이던 원격 조작 판정을 먼저 확정한다(resolvePendingRemote 주석 — 문장 전환의
  // play() 가 알림창 ⏸ 를 덮어쓰는 것을 막는 급소). 원격 정지로 확정되면 스토어 pause 가
  // 곧바로 stopMediaSession 까지 돌리므로 여기서 세션을 다시 켜지 않고 즉시 반환한다.
  if (resolvePendingRemote()) return;
  // 안전망: 상태 이벤트를 못 받은(또는 놓친) 원격 정지. 우리가 재생을 의도했고 앵커가 실제
  // 재생에 도달한 적이 있는데 지금 멈춰 있다면 우리가 안 시킨 정지일 수 있다.
  // ⚠️ 여기서 "즉시" 정지로 확정하면 안 된다(교차검증 Gemini CRITICAL 2026-07-21): 버퍼링·
  // 앱 재개 직후 같은 과도 상태의 playing:false 를 원격 ⏸ 로 오판해 낭독이 저절로 멈춘다 —
  // 이 파일 상단이 "즉시 판정 금지"를 원칙으로 세운 바로 그 이유다. 대신 같은 확인 창에
  // 태우고 이번 호출은 앵커를 켜지 않는다: 과도 상태였다면 playWhenReady 가 살아 있어
  // 200ms 뒤엔 스스로 재생 중으로 관측되고(무판정 통과), 진짜 ⏸ 였다면 그대로 확정된다.
  try {
    if (desiredPlaying && anchorReachedPlaying && !p.playing) {
      if (!confirmTimer) confirmTimer = setTimeout(resolvePendingRemote, REMOTE_CONFIRM_MS);
      return;
    }
  } catch {
    /* 네이티브 읽기 실패 — 종전대로 진행 */
  }
  requestNotificationPermission();
  // 정지→재생 전환 시에만 리셋(문장마다 리셋하면 원격 정지 판정 창이 매 문장 닫힌다).
  if (!desiredPlaying) anchorReachedPlaying = false;
  desiredPlaying = true;
  const meta = { title: title || '소리책', artist: '소리책' };
  // 상태 갱신은 네이티브 호출 성공 후에만 — 먼저 true 로 올려두면 등록이 throw 했을 때
  // 이후 호출이 전부 "이미 등록됨" 분기로 빠져 백그라운드 보호가 재시도 없이 영구 파손된다.
  try {
    if (!sessionActive) {
      p.setActiveForLockScreen(true, meta, {
        showSeekBackward: false,
        showSeekForward: false,
        isLiveStream: true, // 앵커는 무음 루프라 탐색바가 무의미 — 숨김
      });
      sessionActive = true;
      lastTitle = meta.title;
    } else if (lastTitle !== meta.title) {
      p.updateLockScreenMetadata(meta);
      lastTitle = meta.title;
    }
  } catch {
    /* 잠금화면 미지원/등록 실패 — 다음 호출에서 재시도, 낭독은 계속 */
  }
  // 이미 재생 중이면 다시 켜지 않는다 — 앵커를 문장마다 play() 로 두들기면 원격 조작과
  // 우리 호출이 뒤섞여 상태 판정이 흔들린다(FGS 유지에도 재호출은 불필요).
  try {
    if (!p.playing) p.play();
  } catch {
    /* noop */
  }
}

// 세션 종료(일시정지·문서 내리기 등): 잠금화면 알림·mediaPlayback 포그라운드 서비스까지 제거해
// 재생하지 않는 동안 OS 가 앱을 도즈·동결할 수 있게 한다(배터리). 앵커 인스턴스는 재사용 위해 유지.
// (예전 pauseMediaSession = 앵커만 멈추고 FGS 유지 → 정지 중에도 전력 소모, 2026-07-16 폐지.)
export function stopMediaSession(): void {
  desiredPlaying = false;
  stopBgSound(); // 배경 앰비언트도 함께 정지(모든 정지 경로가 이 함수를 거친다)
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  if (!anchor) return;
  try {
    anchor.pause();
    if (sessionActive) anchor.setActiveForLockScreen(false);
  } catch {
    /* noop */
  }
  sessionActive = false;
  lastTitle = null;
}
