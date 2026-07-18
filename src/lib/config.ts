// 앱 버전 — 릴리스 시 app.json(version/runtimeVersion), android/app/build.gradle(versionName/versionCode)과 함께 bump.
export const APP_VERSION = '1.22.0';

// 자동 업데이트용 릴리스 리포지토리 (iwmemo와 동일 방식: releases/latest/download 고정 URL)
export const RELEASE_REPO = 'insushim/iswtts';
export const LATEST_APK_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/SoriBook-latest.apk`;
