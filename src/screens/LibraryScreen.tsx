import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePalette } from '../lib/theme';
import { useLibrary } from '../store/library';
import { importDocument } from '../extract';
import type { RootStackParamList } from '../../App';
import type { Doc } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

const FORMAT_LABEL: Record<string, string> = {
  txt: 'TXT',
  pdf: 'PDF',
  epub: 'EPUB',
  html: 'HTML',
  md: 'MD',
};

export default function LibraryScreen({ navigation }: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const docs = useLibrary((s) => s.docs);
  const addFromText = useLibrary((s) => s.addFromText);
  const remove = useLibrary((s) => s.remove);
  const [busy, setBusy] = useState(false);

  const onImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await importDocument();
      if (!res) return; // 취소
      if (!res.text) {
        Alert.alert('읽을 수 없음', '이 파일에서 텍스트를 찾지 못했습니다. (스캔 PDF는 아직 미지원)');
        return;
      }
      const doc = await addFromText(res);
      if (!doc) {
        Alert.alert('빈 문서', '문장을 추출하지 못했습니다.');
        return;
      }
      navigation.navigate('Player', { docId: doc.id });
    } catch (e: any) {
      Alert.alert('가져오기 실패', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = (doc: Doc) => {
    Alert.alert(doc.title, '이 문서를 삭제할까요?', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => remove(doc.id) },
    ]);
  };

  const renderItem = ({ item }: { item: Doc }) => (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}
      onPress={() => navigation.navigate('Player', { docId: item.id })}
      onLongPress={() => confirmRemove(item)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.sentenceCount}문장, ${Math.round(item.progress * 100)}퍼센트 읽음`}
      accessibilityHint="누르면 읽기 화면을 엽니다. 길게 누르면 삭제합니다."
    >
      <View style={[styles.badge, { backgroundColor: p.primary }]}>
        <Text style={[styles.badgeText, { color: p.onPrimary }]}>
          {FORMAT_LABEL[item.format] || 'DOC'}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: p.text }]} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={[styles.meta, { color: p.subtext }]}>
          {item.sentenceCount}문장 · {Math.round(item.progress * 100)}% 읽음
        </Text>
        <View style={[styles.track, { backgroundColor: p.border }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: p.primary, width: `${Math.round(item.progress * 100)}%` },
            ]}
          />
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.root, { backgroundColor: p.bg, paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Text style={[styles.h1, { color: p.text }]}>소리책</Text>
        <TouchableOpacity
          onPress={() => navigation.navigate('Settings')}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="설정 열기"
        >
          <Text style={[styles.gear, { color: p.subtext }]}>⚙︎</Text>
        </TouchableOpacity>
      </View>

      {docs.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyEmoji]}>📖</Text>
          <Text style={[styles.emptyTitle, { color: p.text }]}>문서를 가져오세요</Text>
          <Text style={[styles.emptyText, { color: p.subtext }]}>
            TXT · PDF · EPUB 파일을 불러와{'\n'}자막처럼 한 줄씩 읽어드립니다.
          </Text>
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => d.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        />
      )}

      <TouchableOpacity
        style={[
          styles.fab,
          { backgroundColor: p.primary, bottom: insets.bottom + 24, opacity: busy ? 0.7 : 1 },
        ]}
        onPress={onImport}
        disabled={busy}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={busy ? '가져오는 중' : '파일 가져오기'}
      >
        {busy ? (
          <ActivityIndicator color={p.onPrimary} />
        ) : (
          <Text style={[styles.fabText, { color: p.onPrimary }]}>＋ 파일 가져오기</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  h1: { fontSize: 30, fontWeight: '800' },
  gear: { fontSize: 24 },
  card: {
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    alignItems: 'center',
  },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '800' },
  title: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 4 },
  track: { height: 4, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyEmoji: { fontSize: 56, marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 21 },
  fab: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 30,
    minWidth: 180,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabText: { fontSize: 16, fontWeight: '800' },
});
