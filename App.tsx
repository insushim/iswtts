import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import LibraryScreen from './src/screens/LibraryScreen';
import PlayerScreen from './src/screens/PlayerScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import PdfExtractor from './src/components/PdfExtractor';
import { checkForUpdate } from './src/lib/appUpdate';
import { sweepCache } from './src/lib/cacheSweep';
import { configureAudioSession } from './src/lib/mediaSession';
import { installCrashLogger, readLastCrash, clearLastCrash } from './src/lib/crashLog';
import { APP_VERSION } from './src/lib/config';
import { initVisibility } from './src/lib/visibility';

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

  // 앱 실행 시: 캐시 잔존물 청소(중단된 합성 mp3·설치 끝난 APK) 후 최신 릴리스 확인.
  // 직전 실행이 크래시로 끝났으면 저장된 로그를 1회 안내(확인 시 삭제).
  useEffect(() => {
    // 화면이 꺼져도 낭독 유지 + 다른 앱 소리와 동시 재생(포커스 미요청).
    configureAudioSession();
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

  // 자막이 화면에 실제로 보이는지(앱이 포그라운드인지)를 엔진에 알린다 — 화면이 꺼지거나 홈으로
  // 백그라운드가 되면 엔진이 하이라이트 폴링·리렌더를 멈춰 배터리를 아낀다(visibility.ts).
  // 낭독(오디오)은 미디어 세션으로 계속된다. (작은 창=PiP 는 RN 이 그 창에서 렌더를 정지시켜
  // 자막이 얼어붙는 Android 구조적 한계라 폐지 — 배경 청취는 잠금화면 컨트롤로 유지. 2026-07-16.)
  useEffect(() => initVisibility(), []);

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
