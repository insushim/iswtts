import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePalette } from '../lib/theme';
import { useSettings } from '../store/settings';
import { systemEngine } from '../tts/ExpoSpeechEngine';
import { APP_VERSION } from '../lib/config';
import type { RootStackParamList } from '../../App';
import type { EngineVoice } from '../tts/TtsEngine';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const LANGS = [
  { code: 'ko-KR', label: '한국어' },
  { code: 'en-US', label: 'English' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'zh-CN', label: '中文' },
];

export default function SettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const s = useSettings();
  const [voices, setVoices] = useState<EngineVoice[]>([]);

  useEffect(() => {
    systemEngine.getVoices().then(setVoices);
  }, []);

  const langVoices = voices.filter((v) =>
    v.language?.toLowerCase().startsWith(s.language.slice(0, 2).toLowerCase()),
  );

  const preview = () => {
    Speech.stop();
    const sample =
      s.language.startsWith('ko')
        ? '안녕하세요. 소리책이 이렇게 읽어드립니다.'
        : 'Hello. This is how SoriBook reads to you.';
    systemEngine.speak(
      sample,
      { rate: s.rate, pitch: s.pitch, language: s.language, voiceId: s.voiceId },
      {},
    );
  };

  const Row = ({
    label,
    value,
    onDec,
    onInc,
  }: {
    label: string;
    value: string;
    onDec: () => void;
    onInc: () => void;
  }) => (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: p.text }]}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity onPress={onDec} style={[styles.stepBtn, { borderColor: p.border }]}>
          <Text style={[styles.stepTxt, { color: p.text }]}>−</Text>
        </TouchableOpacity>
        <Text style={[styles.stepVal, { color: p.text }]}>{value}</Text>
        <TouchableOpacity onPress={onInc} style={[styles.stepBtn, { borderColor: p.border }]}>
          <Text style={[styles.stepTxt, { color: p.text }]}>＋</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const clamp = (v: number, lo: number, hi: number) =>
    Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100;

  return (
    <ScrollView
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 20, paddingTop: insets.top + 12, paddingBottom: 40 }}
    >
      <Text style={[styles.h1, { color: p.text }]}>설정</Text>

      <Text style={[styles.section, { color: p.subtext }]}>언어</Text>
      <View style={styles.chips}>
        {LANGS.map((l) => {
          const active = s.language === l.code;
          return (
            <TouchableOpacity
              key={l.code}
              onPress={() => s.set({ language: l.code, voiceId: undefined })}
              style={[
                styles.chip,
                { borderColor: active ? p.primary : p.border, backgroundColor: active ? p.primary : 'transparent' },
              ]}
            >
              <Text style={{ color: active ? p.onPrimary : p.text, fontWeight: '700' }}>
                {l.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={[styles.section, { color: p.subtext }]}>재생</Text>
      <Row
        label="속도"
        value={`${s.rate.toFixed(2)}×`}
        onDec={() => s.set({ rate: clamp(s.rate - 0.25, 0.5, 3) })}
        onInc={() => s.set({ rate: clamp(s.rate + 0.25, 0.5, 3) })}
      />
      <Row
        label="음높이"
        value={s.pitch.toFixed(2)}
        onDec={() => s.set({ pitch: clamp(s.pitch - 0.1, 0.5, 2) })}
        onInc={() => s.set({ pitch: clamp(s.pitch + 0.1, 0.5, 2) })}
      />
      <Row
        label="자막 글자 크기"
        value={`${Math.round(s.fontScale * 100)}%`}
        onDec={() => s.set({ fontScale: clamp(s.fontScale - 0.1, 0.8, 1.8) })}
        onInc={() => s.set({ fontScale: clamp(s.fontScale + 0.1, 0.8, 1.8) })}
      />

      <TouchableOpacity onPress={preview} style={[styles.previewBtn, { backgroundColor: p.primary }]}>
        <Text style={{ color: p.onPrimary, fontWeight: '800', fontSize: 15 }}>🔊 미리듣기</Text>
      </TouchableOpacity>

      <Text style={[styles.section, { color: p.subtext }]}>
        음성 {langVoices.length ? `(${langVoices.length})` : ''}
      </Text>
      {langVoices.length === 0 ? (
        <Text style={{ color: p.subtext, fontSize: 13, lineHeight: 20 }}>
          이 언어의 설치된 음성이 없습니다. 기기 설정 → 언어/TTS에서 음성 데이터를 내려받으면 더
          자연스러운 목소리를 쓸 수 있습니다.
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          <TouchableOpacity
            onPress={() => s.set({ voiceId: undefined })}
            style={[styles.voice, { borderColor: !s.voiceId ? p.primary : p.border }]}
          >
            <Text style={{ color: p.text, fontWeight: '600' }}>기본 음성</Text>
          </TouchableOpacity>
          {langVoices.map((v) => {
            const active = s.voiceId === v.id;
            return (
              <TouchableOpacity
                key={v.id}
                onPress={() => s.set({ voiceId: v.id })}
                style={[styles.voice, { borderColor: active ? p.primary : p.border }]}
              >
                <Text style={{ color: p.text, fontWeight: active ? '800' : '500' }} numberOfLines={1}>
                  {v.name}
                </Text>
                <Text style={{ color: p.subtext, fontSize: 11 }}>{v.language}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <Text style={[styles.version, { color: p.faint }]}>소리책 v{APP_VERSION}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: 28, fontWeight: '800', marginBottom: 8 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 24, marginBottom: 10, textTransform: 'uppercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  rowLabel: { fontSize: 16, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: { borderWidth: 1, borderRadius: 10, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  stepTxt: { fontSize: 20, fontWeight: '700' },
  stepVal: { fontSize: 16, fontWeight: '700', minWidth: 56, textAlign: 'center' },
  previewBtn: { marginTop: 16, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  voice: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  version: { textAlign: 'center', marginTop: 32, fontSize: 12 },
});
