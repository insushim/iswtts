import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePalette } from '../lib/theme';
import { useSettings } from '../store/settings';
import { usePlayer, resetEdgeCircuit } from '../store/player';
import { getEngine, systemEngine, edgeEngine } from '../tts';
import { EDGE_VOICES } from '../tts/edge/voices';
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

  // expo-speech의 Voice.quality는 현재 'Enhanced' | 'Default'만 반환한다.
  const isHiQuality = (q?: string) => !!q && /enhanced/i.test(q);

  const isEdge = s.engineId === 'edge';

  // 언어 일치 + 고품질(Enhanced/Network) 우선 정렬 → 배속에서 더 또렷한 음성이 위로.
  const systemLangVoices = voices
    .filter((v) => v.language?.toLowerCase().startsWith(s.language.slice(0, 2).toLowerCase()))
    .sort((a, b) => {
      const qa = isHiQuality(a.quality) ? 0 : 1;
      const qb = isHiQuality(b.quality) ? 0 : 1;
      if (qa !== qb) return qa - qb;
      return a.name.localeCompare(b.name);
    });

  const edgeLangVoices = EDGE_VOICES.filter((v) =>
    v.language.toLowerCase().startsWith(s.language.slice(0, 2).toLowerCase()),
  );

  const langVoices = isEdge ? edgeLangVoices : systemLangVoices;
  const selectedVoiceId = isEdge ? s.edgeVoiceId : s.voiceId;
  const selectVoice = (id?: string) =>
    s.set(isEdge ? { edgeVoiceId: id } : { voiceId: id });

  const sampleText = () =>
    s.language.startsWith('ko')
      ? '안녕하세요. 소리책이 이렇게 읽어드립니다.'
      : s.language.startsWith('ja')
        ? 'こんにちは。ソリブックが読み上げます。'
        : s.language.startsWith('zh')
          ? '你好，这是朗读示例。'
          : 'Hello. This is how SoriBook reads to you.';

  const preview = (voiceId?: string) => {
    // 책 재생 중이면 먼저 정지(엔진 싱글턴 공유 → 미리듣기가 재생을 가로채 좀비 상태 방지).
    if (usePlayer.getState().playing) usePlayer.getState().pause();
    // 두 엔진 모두 정지 후, 선택 엔진으로 샘플 발화.
    Speech.stop();
    edgeEngine.stop();
    const engine = getEngine(s.engineId);
    const vId = voiceId ?? (isEdge ? s.edgeVoiceId : s.voiceId);
    engine.speak(
      sampleText(),
      { rate: s.rate, pitch: s.pitch, language: s.language, voiceId: vId },
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

  // iOS AVSpeech는 배속 상한이 ~2× → 플랫폼별 최대 속도.
  const rateMax = Platform.OS === 'ios' ? 2 : 10;

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
              onPress={() => s.set({ language: l.code, voiceId: undefined, edgeVoiceId: undefined })}
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

      <Text style={[styles.section, { color: p.subtext }]}>음성 엔진</Text>
      <View style={{ gap: 8 }}>
        <TouchableOpacity
          onPress={() => s.set({ engineId: 'system' })}
          style={[styles.engine, { borderColor: !isEdge ? p.primary : p.border }]}
        >
          <Text style={{ color: p.text, fontWeight: !isEdge ? '800' : '600' }}>
            기본 (기기 내장) · 오프라인
          </Text>
          <Text style={{ color: p.subtext, fontSize: 12, lineHeight: 18, marginTop: 3 }}>
            인터넷 없이 동작. 기기에 설치된 시스템 음성을 사용합니다.
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            // 사용자가 명시적으로 Edge를 다시 고르면 실패 백오프(서킷)도 초기화해 즉시 재시도.
            resetEdgeCircuit();
            s.set({ engineId: 'edge' });
          }}
          style={[styles.engine, { borderColor: isEdge ? p.primary : p.border }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: p.text, fontWeight: isEdge ? '800' : '600' }}>
              고품질 온라인 (Edge 신경망)
            </Text>
            <View style={[styles.hqBadge, { backgroundColor: p.primary }]}>
              <Text style={{ color: p.onPrimary, fontSize: 9, fontWeight: '800' }}>추천</Text>
            </View>
          </View>
          <Text style={{ color: p.subtext, fontSize: 12, lineHeight: 18, marginTop: 3 }}>
            훨씬 자연스러운 사람 같은 목소리. 무료지만 인터넷이 필요하고, 연결이 안 되면
            자동으로 기본 음성으로 읽어줍니다. (데이터 사용)
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.section, { color: p.subtext }]}>재생</Text>
      <Row
        label="속도"
        value={`${s.rate}×`}
        onDec={() => s.set({ rate: clamp(s.rate - 0.5, 0.5, rateMax) })}
        onInc={() => s.set({ rate: clamp(s.rate + 0.5, 0.5, rateMax) })}
      />
      <Text style={{ color: p.subtext, fontSize: 12, lineHeight: 18, marginTop: 2 }}>
        최대 {rateMax}×까지 지원. 배속해도 음높이는 그대로 유지돼 또렷합니다.
        {isEdge
          ? ' 고품질 온라인(Edge)은 약 6×까지 반영되고, 그 이상은 기본 음성에서 더 빨라집니다.'
          : ' 아주 빠른 속도의 또렷함은 기기 음성 품질을 따릅니다(기기 엔진에 따라 4~5× 부근에서 상한일 수 있음).'}
      </Text>
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

      <TouchableOpacity onPress={() => preview()} style={[styles.previewBtn, { backgroundColor: p.primary }]}>
        <Text style={{ color: p.onPrimary, fontWeight: '800', fontSize: 15 }}>🔊 현재 설정으로 미리듣기</Text>
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
            onPress={() => selectVoice(undefined)}
            style={[styles.voice, { borderColor: !selectedVoiceId ? p.primary : p.border }]}
          >
            <Text style={{ color: p.text, fontWeight: '600' }}>기본 음성</Text>
          </TouchableOpacity>
          {langVoices.map((v) => {
            const active = selectedVoiceId === v.id;
            const hq = isEdge || isHiQuality(v.quality);
            // 중첩 Touchable 회피: 바깥은 View, 선택/미리듣기를 별도 Touchable로 분리.
            return (
              <View
                key={v.id}
                style={[styles.voiceRow, { borderColor: active ? p.primary : p.border }]}
              >
                <TouchableOpacity
                  style={{ flex: 1 }}
                  onPress={() => selectVoice(v.id)}
                  activeOpacity={0.7}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text
                      style={{ color: p.text, fontWeight: active ? '800' : '500' }}
                      numberOfLines={1}
                    >
                      {v.name}
                    </Text>
                    {hq && (
                      <View style={[styles.hqBadge, { backgroundColor: p.primary }]}>
                        <Text style={{ color: p.onPrimary, fontSize: 9, fontWeight: '800' }}>고품질</Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ color: p.subtext, fontSize: 11 }}>{v.language}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => preview(v.id)}
                  hitSlop={10}
                  style={[styles.voicePlay, { borderColor: p.border }]}
                >
                  <Text style={{ color: p.primary, fontSize: 15 }}>▶</Text>
                </TouchableOpacity>
              </View>
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
  engine: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  voiceRow: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  voicePlay: {
    borderWidth: 1,
    borderRadius: 18,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hqBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  version: { textAlign: 'center', marginTop: 32, fontSize: 12 },
});
