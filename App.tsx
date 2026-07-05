import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, Platform, Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import ExpoPip from 'expo-pip';

import LibraryScreen from './src/screens/LibraryScreen';
import PlayerScreen from './src/screens/PlayerScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import PdfExtractor from './src/components/PdfExtractor';
import PipView from './src/components/PipView';
import { usePlayer } from './src/store/player';
import { checkForUpdate } from './src/lib/appUpdate';
import { sweepCache } from './src/lib/cacheSweep';
import { installCrashLogger, readLastCrash, clearLastCrash } from './src/lib/crashLog';
import { APP_VERSION } from './src/lib/config';

// JS 치명 오류를 기기 파일로 남기는 로컬 크래시 로거(외부 전송 없음). 최대한 이른 시점에 설치.
installCrashLogger(APP_VERSION);

export type RootStackParamList = {
  Library: undefined;
  Player: { docId: string };
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const scheme = useColorScheme();
  const { isInPipMode } = ExpoPip.useIsInPip();
  const playing = usePlayer((s) => s.playing);

  // 앱 실행 시: 캐시 잔존물 청소(중단된 합성 mp3·설치 끝난 APK) 후 최신 릴리스 확인.
  // 직전 실행이 크래시로 끝났으면 저장된 로그를 1회 안내(확인 시 삭제).
  useEffect(() => {
    sweepCache();
    const crash = readLastCrash();
    if (crash) {
      Alert.alert(
        '이전 실행 오류 보고',
        `앱이 예기치 않게 종료된 기록이 있습니다. 반복되면 이 내용을 개발자에게 전달해주세요.\n\n${crash.slice(0, 400)}`,
        [{ text: '확인', onPress: clearLastCrash }],
      );
    }
    const t = setTimeout(() => {
      checkForUpdate();
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  // 재생 중일 때만 홈 버튼 시 자동으로 작은 창(PiP)으로 전환(Android 12+). 정지 시엔 일반 홈 동작.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    try {
      ExpoPip.setPictureInPictureParams({ autoEnterEnabled: playing, width: 16, height: 9 });
    } catch {
      /* PiP 미지원 기기/버전 — 무시(일반 동작) */
    }
  }, [playing]);

  // 작은 창 모드에서는 컨트롤 없이 자막만.
  if (isInPipMode) {
    return (
      <SafeAreaProvider>
        <PipView />
        <StatusBar style="light" />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Library" component={LibraryScreen} />
          <Stack.Screen name="Player" component={PlayerScreen} />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ presentation: 'modal' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      {/* PDF 텍스트 추출용 숨겨진 WebView(pdf.js) — 앱 전역에서 1회 마운트 */}
      <PdfExtractor />
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
