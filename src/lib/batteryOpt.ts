import { Platform, Alert } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 백그라운드(화면 꺼짐) 낭독을 도즈/OEM 배터리 관리로부터 지킨다.
//
// 배경(2026-07-16 사용자 "화면 꺼지고 시간 지나면 멈춰버려"): mediaPlayback 포그라운드
// 서비스만으로는 공격적인 배터리 관리 기기(삼성·샤오미 등)에서 백그라운드 앱을 수 분 뒤
// 재우는 걸 못 막는 경우가 있다. 예전엔 홈 진입 시 뜨던 작은 창(PiP)이 앱을 "보이는 창"으로
// 붙잡아 그 강제 절전을 우연히 막고 있었는데, 작은 창을 폐지하며 그 보호가 사라졌다.
// 표준 해법 = 앱을 배터리 최적화 예외로 등록(ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).
// 특히 오프라인(sherpa) 엔진은 합성이 앱 자체 CPU를 쓰므로 백그라운드 CPU가 조여지면 멈춘다.

const PKG = 'com.iwtts.app';
const PROMPTED_KEY = 'iwtts-bgreliability-prompted';
const ACTION = 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS';

async function openRequest(): Promise<void> {
  // data = "package:<앱패키지>" 여야 "이 앱만" 예외 등록 다이얼로그가 뜬다(리스트 전체가 아님).
  await IntentLauncher.startActivityAsync(ACTION, { data: `package:${PKG}` });
}

// 첫 재생 시 1회만 안내(거부해도 다시 조르지 않음 — 설정에서 언제든 다시 열 수 있다).
// 시스템 다이얼로그를 갑자기 띄우지 않고 왜 필요한지 먼저 설명한 뒤 사용자가 열도록 한다.
export async function promptBgReliabilityOnce(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (await AsyncStorage.getItem(PROMPTED_KEY)) return;
    await AsyncStorage.setItem(PROMPTED_KEY, '1');
    Alert.alert(
      '화면을 꺼도 계속 들으려면',
      '일부 기기는 절전 기능이 백그라운드 앱을 멈춰, 화면을 끄면 잠시 뒤 낭독이 끊길 수 있어요. ' +
        '이 앱을 배터리 최적화 예외로 등록하면 화면이 꺼져도 끝까지 이어서 읽어드립니다.\n\n' +
        '(설정 > 배경 재생에서 언제든 다시 열 수 있어요.)',
      [
        { text: '나중에', style: 'cancel' },
        { text: '설정 열기', onPress: () => { void openBatteryOptRequest(); } },
      ],
    );
  } catch {
    /* 미지원/실패 — 무시(FGS 로만 동작) */
  }
}

// 설정 화면에서 사용자가 직접 다시 열 때(또는 위 안내의 "설정 열기").
export async function openBatteryOptRequest(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await openRequest();
  } catch {
    /* 무시 */
  }
}
