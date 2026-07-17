import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { buildAmbientWav, AMBIENT_WAV_SIZE } from './ambientWav';

// 낭독 뒤에 은은히 깔리는 432Hz 배경 앰비언트(선택형). 무음 앵커(mediaSession)와는 별개 플레이어.
// 낭독 오디오와 자동으로 믹싱된다(expo-audio 는 다중 플레이어 동시재생). 재생 중일 때만 돌고,
// 정지/일시정지 시 함께 멈춘다(stopBgSound 는 stopMediaSession 에서 호출 → 모든 정지 경로 커버).

const FILE = 'ambient-432.wav';

let player: AudioPlayer | null = null;
let curVolume = 0.2;

function ensureUri(): string {
  const f = new File(Paths.document, FILE);
  // 이미 있고 크기가 기대값과 같으면 재생성 생략(매 실행 350KB 생성 방지). 손상/구버전이면 다시 만든다.
  if (f.exists && f.size === AMBIENT_WAV_SIZE) return f.uri;
  if (f.exists) f.delete();
  const wav = buildAmbientWav();
  f.create();
  f.write(wav);
  return f.uri;
}

function ensurePlayer(): AudioPlayer | null {
  if (player) return player;
  try {
    const p = createAudioPlayer(ensureUri());
    p.loop = true;
    p.volume = curVolume;
    player = p;
    return p;
  } catch {
    return null; // 생성 실패 = 배경음만 포기, 낭독은 계속
  }
}

/** 배경음 시작(낭독 중, 설정이 켜져 있을 때만 호출). volume 0..1. 멱등(이미 재생 중이면 볼륨만 갱신). */
export function startBgSound(volume: number): void {
  curVolume = volume;
  const p = ensurePlayer();
  if (!p) return;
  try {
    p.volume = volume;
    p.play();
  } catch {
    /* noop */
  }
}

/** 배경음 정지(일시정지·정지·책끝 등). 플레이어 인스턴스는 재사용 위해 유지. */
export function stopBgSound(): void {
  if (!player) return;
  try {
    player.pause();
  } catch {
    /* noop */
  }
}

/** 재생 중 볼륨 실시간 반영(설정에서 조절 시). */
export function setBgVolume(volume: number): void {
  curVolume = volume;
  if (player) {
    try {
      player.volume = volume;
    } catch {
      /* noop */
    }
  }
}

/** 지금 배경음이 재생 중인지(설정 화면 미리듣기 토글용). */
export function isBgPlaying(): boolean {
  try {
    return !!player?.playing;
  } catch {
    return false;
  }
}
