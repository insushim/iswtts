# 소리책 (iwtts)

온디바이스 TTS 리더 — 문서를 **영화 자막처럼 한 줄씩 화면 중앙에** 띄우며 읽어주는 안드로이드 앱.

## 특징 (v1)
- **완전 온디바이스**: 시스템 TTS(구글/삼성 등)로 읽음. 서버·계정·요금 0. 재생은 오프라인.
- **자막형 리더**: 현재 문장을 중앙에 크게, 앞뒤 문장은 흐리게. 재생 중 **단어 하이라이트(가라오케)** — expo-speech `onBoundary` 동기화.
- **파일 지원**: TXT · EPUB(오프라인) · PDF(텍스트, pdf.js). 스캔 PDF(OCR)는 후속.
- **읽기 관리**: 라이브러리·진행률 저장/복원, 속도·음높이·글자크기·음성·언어 설정.

## 아키텍처
- Expo(SDK 57) + React Native + TypeScript, react-navigation, zustand.
- `src/tts/TtsEngine.ts` = 엔진 추상화(전략 패턴). v1은 `ExpoSpeechEngine`(시스템 TTS).
  나중에 sherpa-onnx(오프라인 신경망)·자가호스팅 Fish Speech(클라우드/음성 클로닝)를
  **UI 변경 없이** 같은 인터페이스로 스왑. (상세 설계 = 상위 폴더 `../DESIGN.md`)

## 빌드 (macOS)
```bash
# 사전: JDK17, Android SDK(android/local.properties의 sdk.dir)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
npx expo prebuild -p android            # android/ 생성 (최초 1회)
cd android && ./gradlew assembleRelease  # → app/build/outputs/apk/release/app-release.apk
```
개발 실행: `npx expo run:android` (에뮬/실기 연결 시).

## 릴리스 (iwmemo와 동일 방식)
버전 4곳(`src/lib/config.ts`, `app.json` version+runtimeVersion, `android/app/build.gradle` versionName·versionCode) bump 후:
```bash
scripts/release.sh --push
```
→ `SoriBook-latest.apk`(고정명) + 버전명 APK를 GitHub 릴리스에 첨부.
고정 최신 URL: `https://github.com/insushim/iswtts/releases/latest/download/SoriBook-latest.apk`

## 로드맵
- v1.1: 스캔 PDF OCR(ML Kit), DOCX, 오프라인 번들 pdf.js, 백그라운드 재생(포그라운드 서비스)
- v2: sherpa-onnx 오프라인 신경망 음성
- v3: 자가호스팅 Fish Speech — 프리미엄 음질 + **내 목소리 클로닝**(글자당 과금 0)
