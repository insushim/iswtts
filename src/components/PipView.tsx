import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { usePlayer } from '../store/player';

// PiP(작은 창) 전용 최소 화면 — 컨트롤 없이 현재 문장 자막만 크게. 재생은 백그라운드로 계속된다.
export default function PipView() {
  const sentences = usePlayer((s) => s.sentences);
  const index = usePlayer((s) => s.index);
  const wordStart = usePlayer((s) => s.wordStart);
  const wordLen = usePlayer((s) => s.wordLen);

  const cur = sentences[index] || '';
  const hlEnd = wordLen > 0 ? wordStart + wordLen : 0;
  const before = wordLen > 0 ? cur.slice(0, wordStart) : cur;
  const word = wordLen > 0 ? cur.slice(wordStart, hlEnd) : '';
  const after = wordLen > 0 ? cur.slice(hlEnd) : '';

  return (
    <View style={styles.root}>
      <Text style={styles.text} numberOfLines={4} adjustsFontSizeToFit minimumFontScale={0.6}>
        <Text>{before}</Text>
        <Text style={styles.hl}>{word}</Text>
        <Text>{after}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f0f14', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  text: { color: '#f5f5f7', fontSize: 20, fontWeight: '700', textAlign: 'center', lineHeight: 28 },
  hl: { color: '#c7d2fe', backgroundColor: 'rgba(99,102,241,0.28)' },
});
