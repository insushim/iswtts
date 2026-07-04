import { Alert, Linking, Platform } from 'react-native';
import {
  cacheDirectory,
  downloadAsync,
  getContentUriAsync,
} from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { APP_VERSION, RELEASE_REPO } from './config';

// 앱 실행 시 GitHub 최신 릴리스를 확인 → 새 버전이면 안내 → APK 다운로드 → 안드로이드 설치창 오픈.
// 사이드로드 앱 특성상 '무음 강제설치'는 불가(보안) — 사용자가 설치창에서 한 번 탭한다.
// iwmemo(appUpdate.ts)와 동등 동작을, 커스텀 네이티브 모듈 없이 Expo 표준 모듈로 구현.

const GITHUB_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

let updateInProgress = false;

function compareVersions(current: string, latest: string): number {
  const c = current.replace(/^v/, '').split('.').map(Number);
  const l = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (lv > cv) return 1;
    if (lv < cv) return -1;
  }
  return 0;
}

async function startUpdate(apkUrl: string, version: string): Promise<void> {
  if (updateInProgress) return;
  updateInProgress = true;
  try {
    // 1) 캐시로 다운로드 → content:// URI → 설치 인텐트
    const target = `${cacheDirectory}SoriBook-${version}.apk`;
    const { uri } = await downloadAsync(apkUrl, target);
    const contentUri = await getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      type: 'application/vnd.android.package-archive',
    });
  } catch (e) {
    if (__DEV__) console.warn('APK 설치 인텐트 실패, 브라우저 폴백:', e);
    // 2) 폴백: 브라우저로 다운로드(사용자가 알림에서 설치)
    try {
      await Linking.openURL(apkUrl);
    } catch {
      /* 무시 */
    }
  } finally {
    setTimeout(() => {
      updateInProgress = false;
    }, 5000);
  }
}

export async function checkForUpdate(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(GITHUB_API_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return;

    const release = await res.json();
    const latest = (release.tag_name || '').replace(/^v/, '');
    if (!latest || compareVersions(APP_VERSION, latest) <= 0) return;

    // 고정명 애셋 우선, 없으면 아무 .apk
    const assets = release.assets || [];
    const apk =
      assets.find((a: any) => a.name === 'SoriBook-latest.apk' && a.browser_download_url) ||
      assets.find((a: any) => a.name?.endsWith('.apk') && a.browser_download_url);
    if (!apk) return;

    Alert.alert(
      '업데이트 알림',
      `새 버전 v${latest}이 있습니다.\n(현재: v${APP_VERSION})\n\n${release.name || ''}`,
      [
        { text: '나중에', style: 'cancel' },
        { text: '업데이트', onPress: () => startUpdate(apk.browser_download_url, latest) },
      ],
    );
  } catch {
    // 업데이트 체크 실패는 조용히 무시
  }
}
