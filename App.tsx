import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, Platform } from 'react-native';
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

  // 앱 실행 시 최신 릴리스 확인(새 버전이면 안내 → 다운로드 → 설치창)
  useEffect(() => {
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
