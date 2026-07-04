// 재생 전용 앱: expo-audio 가 자동 추가하는 RECORD_AUDIO(마이크) 권한을 제거한다.
// microphonePermission:false 옵션만으로는 소스 매니페스트에 남아, 매니페스트 병합 단계에서
// tools:node="remove" 로 확실히 걷어낸다. 녹음 기능이 없으므로 재생에는 영향 없음.
const { withAndroidManifest } = require('@expo/config-plugins');

const RECORD_AUDIO = 'android.permission.RECORD_AUDIO';

module.exports = function withRemoveRecordAudio(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';

    const perms = manifest['uses-permission'] || [];
    // 기존 RECORD_AUDIO 항목 제거
    const filtered = perms.filter((p) => p?.$?.['android:name'] !== RECORD_AUDIO);
    // 병합으로 재유입되지 못하게 remove 노드 추가
    filtered.push({ $: { 'android:name': RECORD_AUDIO, 'tools:node': 'remove' } });
    manifest['uses-permission'] = filtered;
    return cfg;
  });
};
