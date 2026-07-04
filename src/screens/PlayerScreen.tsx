import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePalette } from '../lib/theme';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { useSettings } from '../store/settings';
import type { RootStackParamList } from '../../App';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

export default function PlayerScreen({ route, navigation }: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { docId } = route.params;

  const player = usePlayer();
  const fontScale = useSettings((s) => s.fontScale);
  const rate = useSettings((s) => s.rate);
  const setSettings = useSettings((s) => s.set);
  const loadSentences = useLibrary((s) => s.loadSentences);
  const docs = useLibrary((s) => s.docs);
  const [loading, setLoading] = useState(true);

  // 문서 로드
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const doc = docs.find((d) => d.id === docId);
        const sentences = await loadSentences(docId);
        if (!alive) return;
        usePlayer.getState().load({
          docId,
          title: doc?.title || '읽기',
          sentences,
          startIndex: doc?.lastIndex ?? 0,
        });
      } catch (e: any) {
        Alert.alert('열기 실패', String(e?.message || e));
        navigation.goBack();
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // 화면을 벗어나면 정지
  useEffect(() => {
    return () => {
      usePlayer.getState().pause();
    };
  }, []);

  // 재생 중 화면 켜두기
  useEffect(() => {
    if (player.playing) activateKeepAwakeAsync('iwtts');
    else deactivateKeepAwake('iwtts');
  }, [player.playing]);

  const { sentences, index, wordStart, wordLen, playing } = player;
  const cur = sentences[index] || '';
  const prev = index > 0 ? sentences[index - 1] : '';
  const nextS = index < sentences.length - 1 ? sentences[index + 1] : '';

  const bigSize = Math.round(26 * fontScale);
  const smallSize = Math.round(16 * fontScale);

  // 현재 문장을 [앞 · 하이라이트 단어 · 뒤]로 분해
  const hlEnd = wordLen > 0 ? wordStart + wordLen : 0;
  const before = wordLen > 0 ? cur.slice(0, wordStart) : cur;
  const word = wordLen > 0 ? cur.slice(wordStart, hlEnd) : '';
  const after = wordLen > 0 ? cur.slice(hlEnd) : '';

  // 배속 프리셋. Android setSpeechRate는 피치 보존 배속(최대 10×, 기기 엔진에 따라 상한).
  // iOS AVSpeech는 상한이 ~2×라 2× 초과는 무효 → iOS에선 2×까지만 노출.
  const RATE_STEPS =
    Platform.OS === 'ios'
      ? [0.5, 1.0, 1.5, 2.0]
      : [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0];
  const cycleRate = () => {
    // 현재 속도보다 큰 첫 프리셋으로 이동, 없으면 처음으로 순환.
    // (설정 스테퍼로 만든 프리셋 밖 값 0.5·1.75·4.75 등에서도 0.75로 급락하지 않음)
    const nextRate = RATE_STEPS.find((s) => s > rate + 0.001) ?? RATE_STEPS[0];
    setSettings({ rate: nextRate });
    // 재생 중이면 즉시 반영(현재 문장을 새 속도로 다시 발화)
    if (usePlayer.getState().playing) {
      usePlayer.getState().seek(usePlayer.getState().index);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: p.bg }]}>
        <ActivityIndicator color={p.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: p.bg }]}>
      {/* 상단 바 */}
      <View style={[styles.topbar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={12}>
          <Text style={[styles.back, { color: p.subtext }]}>‹ 목록</Text>
        </TouchableOpacity>
        <Text style={[styles.count, { color: p.subtext }]}>
          {sentences.length ? index + 1 : 0} / {sentences.length}
        </Text>
      </View>

      {/* 자막 영역: 이전(흐림) · 현재(중앙 크게) · 다음(흐림) */}
      <View style={styles.stage}>
        {!!prev && (
          <Text
            style={[styles.neighbor, { color: p.faint, fontSize: smallSize }]}
            numberOfLines={2}
          >
            {prev}
          </Text>
        )}

        <Text style={[styles.current, { fontSize: bigSize, color: p.text }]}>
          {before}
          {!!word && (
            <Text
              style={{
                color: p.highlightText,
                backgroundColor: p.highlight,
                fontWeight: '800',
              }}
            >
              {word}
            </Text>
          )}
          {after}
        </Text>

        {!!nextS && (
          <Text
            style={[styles.neighbor, { color: p.faint, fontSize: smallSize }]}
            numberOfLines={2}
          >
            {nextS}
          </Text>
        )}
      </View>

      {/* 진행 바 */}
      <View style={[styles.track, { backgroundColor: p.border }]}>
        <View
          style={[
            styles.fill,
            {
              backgroundColor: p.primary,
              width: `${sentences.length ? ((index + 1) / sentences.length) * 100 : 0}%`,
            },
          ]}
        />
      </View>

      {/* 컨트롤 */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity onPress={() => player.prev()} hitSlop={10} style={styles.ctrlBtn}>
          <Text style={[styles.ctrlIcon, { color: p.text }]}>⏮</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => player.toggle()}
          style={[styles.playBtn, { backgroundColor: p.primary }]}
          activeOpacity={0.85}
        >
          <Text style={[styles.playIcon, { color: p.onPrimary }]}>
            {playing ? '⏸' : '▶'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => player.next()} hitSlop={10} style={styles.ctrlBtn}>
          <Text style={[styles.ctrlIcon, { color: p.text }]}>⏭</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={cycleRate}
          style={[styles.rateBtn, { borderColor: p.border }]}
        >
          <Text style={[styles.rateText, { color: p.text }]}>{rate}×</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  back: { fontSize: 16, fontWeight: '600' },
  count: { fontSize: 14, fontWeight: '600' },
  stage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 22,
  },
  neighbor: { textAlign: 'center', lineHeight: 24 },
  current: { textAlign: 'center', fontWeight: '700', lineHeight: 40 },
  track: { height: 5, marginHorizontal: 20, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    paddingTop: 20,
  },
  ctrlBtn: { padding: 10 },
  ctrlIcon: { fontSize: 30 },
  playBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  playIcon: { fontSize: 30 },
  rateBtn: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: 'absolute',
    right: 20,
  },
  rateText: { fontSize: 14, fontWeight: '700' },
});
