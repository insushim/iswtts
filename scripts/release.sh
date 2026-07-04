#!/usr/bin/env bash
#
# 소리책(iwtts) 릴리스 자동화 (macOS) — iwmemo와 동일 방식
# ─────────────────────────────────────────────────────────────
# - 현재 코드 버전(src/lib/config.ts APP_VERSION)으로 release APK 빌드
# - 버전명 애셋 + 고정명 애셋(SoriBook-latest.apk) 둘 다 첨부해 GitHub 릴리스 생성
# - 그래야 고정 최신 URL이 유지됨:
#     https://github.com/insushim/iswtts/releases/latest/download/SoriBook-latest.apk
#   (최신 릴리스에 그 고정명 애셋이 없으면 이 URL이 404 → 이 스크립트가 누락 방지)
#
# 사용법:
#   scripts/release.sh                  # config.ts 버전으로 빌드 + 릴리스
#   scripts/release.sh --push           # 릴리스 전에 git push
#   scripts/release.sh --no-build       # 이미 빌드된 APK로 릴리스만
#   scripts/release.sh --notes notes.md --title "제목" --push
#
# 사전조건: gh 인증, JDK17, android/local.properties의 sdk.dir, 버전 4곳 동일 bump
#   (config.ts APP_VERSION / app.json version+runtimeVersion / build.gradle versionName, versionCode+1).
set -euo pipefail

REPO="insushim/iswtts"
LATEST_ASSET="SoriBook-latest.apk"   # ← 고정 URL을 만드는 불변 파일명. 절대 바꾸지 말 것.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

DO_BUILD=1; DO_PUSH=0; NOTES_FILE=""; TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) DO_BUILD=0; shift ;;
    --push)     DO_PUSH=1; shift ;;
    --notes)    NOTES_FILE="${2:?--notes 뒤에 파일 경로 필요}"; shift 2 ;;
    --title)    TITLE="${2:?--title 뒤에 제목 필요}"; shift 2 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✗ 알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

semver() { grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

ver_config=$(grep -oE "APP_VERSION *= *'[0-9.]+'" src/lib/config.ts | semver || true)
ver_app=$(grep -oE '"version": *"[0-9.]+"' app.json | semver || true)
ver_runtime=$(grep -oE '"runtimeVersion": *"[0-9.]+"' app.json | semver || true)
ver_gradle=$(grep -oE 'versionName *"[0-9.]+"' android/app/build.gradle | semver || true)

[[ -n "$ver_config" ]] || { echo "✗ config.ts에서 APP_VERSION을 못 찾음"; exit 1; }
VER="$ver_config"
if [[ "$ver_app" != "$VER" || "$ver_runtime" != "$VER" || "$ver_gradle" != "$VER" ]]; then
  echo "✗ 버전 불일치 — 릴리스 중단"
  echo "    config.ts        = $ver_config"
  echo "    app.json version = $ver_app"
  echo "    app.json runtime = $ver_runtime"
  echo "    build.gradle     = $ver_gradle"
  echo "  4곳을 동일하게 맞추고 versionCode도 +1 했는지 확인하세요."
  exit 1
fi
TAG="v$VER"
VERSIONED_ASSET="SoriBook-${TAG}-release.apk"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "▶ 버전 $VER  (태그 $TAG, 브랜치 $BRANCH)"

command -v gh >/dev/null || { echo "✗ gh CLI 없음"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ gh 인증 필요: gh auth login"; exit 1; }
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "✗ 릴리스 $TAG 가 이미 존재합니다. 버전을 올리거나 기존 릴리스를 먼저 삭제하세요."; exit 1
fi

if [[ $DO_PUSH -eq 1 ]]; then
  echo "▶ git push origin $BRANCH"
  git push origin "$BRANCH"
fi

# JDK17
if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME:-/nonexistent}/bin/java" ]]; then
  if [[ -x /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java ]]; then
    export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  elif /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    JAVA_HOME="$(/usr/libexec/java_home -v 17)"; export JAVA_HOME
  else echo "✗ JDK17을 못 찾음. brew install openjdk@17"; exit 1; fi
fi
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-/Users/sim-insu/android-sdk}"
echo "▶ JDK: $(java -version 2>&1 | head -1)"

APK_OUT="android/app/build/outputs/apk/release/app-release.apk"
if [[ $DO_BUILD -eq 1 ]]; then
  echo "▶ ./gradlew assembleRelease"
  ( cd android && ./gradlew assembleRelease --console=plain )
fi
[[ -f "$APK_OUT" ]] || { echo "✗ APK 산출물 없음: $APK_OUT"; exit 1; }

cp -f "$APK_OUT" "$VERSIONED_ASSET"
cp -f "$APK_OUT" "$LATEST_ASSET"
echo "▶ 애셋: $VERSIONED_ASSET + $LATEST_ASSET (← 고정 URL용)"

[[ -n "$TITLE" ]] || TITLE="소리책 $TAG"
if [[ -n "$NOTES_FILE" ]]; then
  NOTES_ARGS=(--notes-file "$NOTES_FILE")
else
  NOTES_ARGS=(--notes "소리책 ${TAG} — 온디바이스 TTS 리더 (자막형 읽기)")
fi

echo "▶ gh release create $TAG"
gh release create "$TAG" "$VERSIONED_ASSET" "$LATEST_ASSET" \
  -R "$REPO" --target "$BRANCH" --title "$TITLE" "${NOTES_ARGS[@]}"

echo "✓ 완료: https://github.com/$REPO/releases/tag/$TAG"
echo "  고정 최신 URL: https://github.com/$REPO/releases/latest/download/$LATEST_ASSET"
