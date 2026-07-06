const { withGradleProperties } = require('expo/config-plugins');

// sherpa-onnx 도입으로 APK가 228MB까지 커지는 것을 절감하는 빌드 설정(실측 2026-07-06).
// ① FFmpeg 제거: 우리는 TTS 합성만 쓴다(FFmpeg는 STT용 오디오 디코드 — convertAudio* 계열만 실패).
//    모델 아카이브 해제는 libarchive라 영향 없음.
// ② ABI를 실기기용(arm64-v8a, armeabi-v7a)으로 제한 — x86/x86_64는 에뮬레이터용.
// prebuild --clean 이 gradle.properties 를 재생성하므로 config 플러그인으로 영속화한다.
module.exports = function withSherpaSlim(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const upsert = (key, value) => {
      const existing = props.find((p) => p.type === 'property' && p.key === key);
      if (existing) existing.value = value;
      else props.push({ type: 'property', key, value });
    };
    upsert('sherpaOnnxDisableFfmpeg', 'true');
    upsert('reactNativeArchitectures', 'arm64-v8a,armeabi-v7a');
    return cfg;
  });
};
