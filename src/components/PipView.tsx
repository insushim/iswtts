import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { usePlayer } from '../store/player';
import { splitHighlight } from '../lib/highlight';

// PiP(작은 창) 전용 최소 화면 — 컨트롤 없이 현재 문장 자막만 크게. 재생은 백그라운드로 계속된다.
export default function PipView() {
  const sentences = usePlayer((s) => s.sentences);
  const index = usePlayer((s) => s.index);
  const wordStart = usePlayer((s) => s.wordStart);
  const wordLen = usePlayer((s) => s.wordLen);
  const { height } = useWindowDimensions();

  const cur = sentences[index] || '';
  const { before, word, after } = splitHighlight(cur, wordStart, wordLen);

  // 글자 크기는 PiP 창 높이에 맞춰 직접 계산한다. adjustsFontSizeToFit는 Android에서
  // 중첩 Text(하이라이트 조각)와 함께 쓰면 동작하지 않아 글자가 큰 채로 잘려 보였다
  // (2026-07-08 사용자 보고 "작은 화면에서 글씨가 고정"). 4줄 × 1.4 행간 + 여백이
  // 창 높이 안에 들어오는 크기로 잡는다.
  const fontSize = Math.max(11, Math.min(24, Math.floor(height / 7)));
  const lineHeight = Math.round(fontSize * 1.4);

  return (
    <View style={styles.root}>
      <Text style={[styles.text, { fontSize, lineHeight }]} numberOfLines={4}>
        <Text>{before}</Text>
        <Text style={styles.hl}>{word}</Text>
        <Text>{after}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f0f14', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  text: { color: '#f5f5f7', fontWeight: '700', textAlign: 'center' },
  hl: { color: '#c7d2fe', backgroundColor: 'rgba(99,102,241,0.28)' },
});
