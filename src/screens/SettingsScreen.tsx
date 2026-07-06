import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePalette } from '../lib/theme';
import { useSettings } from '../store/settings';
import { usePlayer, resetEngineCircuit } from '../store/player';
import { getEngine, systemEngine, edgeEngine, sherpaEngine } from '../tts';
import { EDGE_VOICES } from '../tts/edge/voices';
import {
  isSherpaModelReady,
  isSherpaDownloadActive,
  downloadSherpaModel,
  cancelSherpaDownload,
  deleteSherpaModel,
  SHERPA_MODEL_MB,
} from '../lib/sherpaModel';
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
  const [sherpaVoices, setSherpaVoices] = useState<EngineVoice[]>([]);
  const [previewFail, setPreviewFail] = useState(false);
  // 오프라인 모델 상태: 'checking' | 'none' | 'downloading' | 'ready'
  const [modelState, setModelState] = useState<'checking' | 'none' | 'downloading' | 'ready'>('checking');
  const [dlPercent, setDlPercent] = useState(0);
  const [dlPhase, setDlPhase] = useState<'downloading' | 'extracting'>('downloading');
  const [dlError, setDlError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const dlDetach = useRef<(() => void) | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    systemEngine
      .getVoices()
      .then((v) => {
        if (aliveRef.current) setVoices(v);
      })
      .catch(() => {
        /* 음성 목록 조회 실패 → 빈 목록 안내가 대신 표시됨 */
      });
    sherpaEngine.getVoices().then((v) => {
      if (aliveRef.current) setSherpaVoices(v);
    });
    // 화면을 나갔다 와도 진행 중 다운로드에 다시 합류(싱글턴).
    if (isSherpaDownloadActive()) attachToDownload();
    else
      isSherpaModelReady().then((ready) => {
        if (aliveRef.current && !isSherpaDownloadActive()) setModelState(ready ? 'ready' : 'none');
      });
    return () => {
      aliveRef.current = false;
      dlDetach.current?.(); // 진행률 리스너 해제(다운로드 자체는 계속)
      dlDetach.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 화면을 떠나면 미리듣기 발화도 정지(안 하면 뒤로 간 뒤에도 계속 재생됨).
  // 다운로드는 유지(취소는 명시 버튼으로만) — 나갔다 와도 이어받는다(ensureModel 재개).
  useEffect(() => {
    return () => {
      Speech.stop();
      edgeEngine.stop();
      sherpaEngine.stop();
    };
  }, []);

  // 진행 중(또는 새) 다운로드에 진행률 리스너를 붙이고 완료/실패를 화면 상태에 반영.
  const attachToDownload = () => {
    setDlError(null);
    setModelState('downloading');
    const { promise, detach } = downloadSherpaModel((prog) => {
      if (!aliveRef.current) return;
      setDlPercent(Math.max(0, Math.min(100, Math.round(prog.percent || 0))));
      if (prog.phase) setDlPhase(prog.phase);
    });
    dlDetach.current = detach;
    promise.then(
      () => {
        // 받자마자 곧바로 이 엔진으로 듣게 선택까지 완료(사용자 의도가 명확).
        // 단, 다른 엔진으로 낭독 중이면 문장 중간에 목소리가 조용히 바뀌지 않게 전환 보류.
        resetEngineCircuit('sherpa');
        if (!usePlayer.getState().playing) {
          useSettings.getState().set({ engineId: 'sherpa' });
        }
        if (aliveRef.current) setModelState('ready');
      },
      (e) => {
        if (!aliveRef.current) return;
        setModelState('none');
        const msg = String((e as Error)?.message || e);
        // 실제 원인을 그대로 보여준다 — 뭉뚱그린 안내("인터넷/저장공간 확인")는 둘 다
        // 멀쩡할 때 사용자가 원인을 좁힐 수 없었다(2026-07-06 실사용 보고).
        setDlError(
          /abort/i.test(msg)
            ? null // 사용자 취소는 오류 아님
            : `다운로드에 실패했습니다 — ${msg.slice(0, 140)}`,
        );
      },
    );
  };

  const startModelDownload = () => {
    if (modelState === 'downloading') return;
    setDlPercent(0);
    setDlPhase('downloading');
    attachToDownload();
  };

  const cancelModelDownload = () => {
    cancelSherpaDownload();
  };

  const confirmDeleteModel = () => {
    Alert.alert('오프라인 음성 삭제', '내려받은 음성 데이터를 삭제할까요? 필요하면 다시 받을 수 있습니다.', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: async () => {
          // 재생 중 삭제 방어: 이 엔진으로 낭독 중일 수 있다 — 재생을 먼저 멈추지 않으면
          // releaseNative 가 재생 중 인스턴스를 파괴해 onDone/onError 없이 영구 고착된다.
          if (usePlayer.getState().playing) usePlayer.getState().pause();
          if (useSettings.getState().engineId === 'sherpa') s.set({ engineId: 'system' });
          await sherpaEngine.releaseNative(); // 파일을 쥔 채 지우지 않게 먼저 해제
          await deleteSherpaModel();
          if (aliveRef.current) setModelState('none');
        },
      },
    ]);
  };

  // expo-speech의 Voice.quality는 현재 'Enhanced' | 'Default'만 반환한다.
  const isHiQuality = (q?: string) => !!q && /enhanced/i.test(q);

  const isEdge = s.engineId === 'edge';
  const isSherpa = s.engineId === 'sherpa';

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

  // sherpa(다국어 단일 모델)는 화자 목록이 언어와 무관 — 필터 없이 전체.
  const langVoices = isSherpa ? sherpaVoices : isEdge ? edgeLangVoices : systemLangVoices;
  const selectedVoiceId = isSherpa ? s.sherpaVoiceId : isEdge ? s.edgeVoiceId : s.voiceId;
  const selectVoice = (id?: string) =>
    s.set(isSherpa ? { sherpaVoiceId: id } : isEdge ? { edgeVoiceId: id } : { voiceId: id });

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
    // 모든 엔진 정지 후, 선택 엔진으로 샘플 발화.
    Speech.stop();
    edgeEngine.stop();
    sherpaEngine.stop();
    setPreviewFail(false);
    const engine = getEngine(s.engineId);
    const vId = voiceId ?? (isSherpa ? s.sherpaVoiceId : isEdge ? s.edgeVoiceId : s.voiceId);
    engine.speak(
      sampleText(),
      { rate: s.rate, pitch: s.pitch, language: s.language, voiceId: vId },
      {
        // 실패 시 무음+무피드백이면 사용자가 원인을 알 수 없다 → 안내 텍스트 표시.
        onError: () => setPreviewFail(true),
      },
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
        <TouchableOpacity
          onPress={onDec}
          style={[styles.stepBtn, { borderColor: p.border }]}
          accessibilityRole="button"
          accessibilityLabel={`${label} 줄이기, 현재 ${value}`}
        >
          <Text style={[styles.stepTxt, { color: p.text }]}>−</Text>
        </TouchableOpacity>
        <Text style={[styles.stepVal, { color: p.text }]}>{value}</Text>
        <TouchableOpacity
          onPress={onInc}
          style={[styles.stepBtn, { borderColor: p.border }]}
          accessibilityRole="button"
          accessibilityLabel={`${label} 늘리기, 현재 ${value}`}
        >
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
              accessibilityRole="button"
              accessibilityLabel={`언어 ${l.label}`}
              accessibilityState={{ selected: active }}
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
          style={[styles.engine, { borderColor: s.engineId === 'system' ? p.primary : p.border }]}
          accessibilityRole="button"
          accessibilityLabel="기본 기기 내장 음성 엔진, 오프라인"
          accessibilityState={{ selected: s.engineId === 'system' }}
        >
          <Text style={{ color: p.text, fontWeight: s.engineId === 'system' ? '800' : '600' }}>
            기본 (기기 내장) · 오프라인
          </Text>
          <Text style={{ color: p.subtext, fontSize: 12, lineHeight: 18, marginTop: 3 }}>
            인터넷 없이 동작. 기기에 설치된 시스템 음성을 사용합니다.
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            // 사용자가 명시적으로 Edge를 다시 고르면 실패 백오프(서킷)도 초기화해 즉시 재시도.
            resetEngineCircuit('edge');
            s.set({ engineId: 'edge' });
          }}
          style={[styles.engine, { borderColor: isEdge ? p.primary : p.border }]}
          accessibilityRole="button"
          accessibilityLabel="고품질 온라인 Edge 신경망 음성 엔진"
          accessibilityState={{ selected: isEdge }}
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
            자동으로 기본 음성으로 읽어줍니다. (데이터 사용){'\n'}
            ※ 이 엔진 사용 시 읽는 문장이 음성 생성을 위해 Microsoft 서버로 전송됩니다.
          </Text>
        </TouchableOpacity>
        {isEdge && (
          <TouchableOpacity
            onPress={() => s.set({ edgeHighSpeedFallback: !s.edgeHighSpeedFallback })}
            style={[styles.engine, { borderColor: p.border }]}
            accessibilityRole="switch"
            accessibilityLabel="2배속 초과 시 기본 음성으로 자동 전환"
            accessibilityState={{ checked: s.edgeHighSpeedFallback }}
          >
            <Text style={{ color: p.text, fontWeight: '600' }}>
              {s.edgeHighSpeedFallback ? '☑' : '☐'} 2배속 초과 시 기본 음성으로 자동 전환
            </Text>
            <Text style={{ color: p.subtext, fontSize: 12, lineHeight: 18, marginTop: 3 }}>
              온라인 음성은 기술적으로 2배속까지만 또렷합니다. 끄면 온라인 음성을 유지하는
              대신 속도가 최대 2배속으로 제한됩니다.
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => {
            if (modelState === 'ready') {
              resetEngineCircuit('sherpa');
              s.set({ engineId: 'sherpa' });
            } else if (modelState === 'none') {
              startModelDownload();
            }
          }}
          disabled={modelState === 'checking'}
          style={[styles.engine, { borderColor: isSherpa ? p.primary : p.border }]}
          accessibilityRole="button"
          accessibilityLabel={
            modelState === 'ready'
              ? '고품질 오프라인 신경망 음성 엔진'
              : `고품질 오프라인 신경망 음성 엔진, 음성 데이터 ${SHERPA_MODEL_MB}메가바이트 다운로드 필요`
          }
          accessibilityState={{ selected: isSherpa, disabled: modelState === 'checking' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: p.text, fontWeight: isSherpa ? '800' : '600' }}>
              고품질 오프라인 (신경망)
            </Text>
            <View style={[styles.hqBadge, { backgroundColor: p.primary }]}>
              <Text style={{ color: p.onPrimary, fontSize: 9, fontWeight: '800' }}>NEW</Text>
            </View>
          </View>
          <Text style={{ color: p.subtext, fontSize: 12, lineHeight: 18, marginTop: 3 }}>
            자연스러운 목소리를 인터넷 없이. 기기 안에서만 음성을 만들어 어떤 문장도 밖으로
            전송되지 않습니다. 화자 10명.
          </Text>
          {modelState === 'none' && (
            <Text style={{ color: p.primary, fontSize: 12, fontWeight: '700', marginTop: 6 }}>
              ⬇ 눌러서 음성 데이터 받기 ({SHERPA_MODEL_MB}MB · 와이파이 권장 · 받는 동안 앱을 열어두세요)
            </Text>
          )}
          {modelState === 'downloading' && (
            <View style={{ marginTop: 8 }}>
              <View style={[styles.dlBar, { backgroundColor: p.border }]}>
                <View
                  style={[styles.dlFill, { backgroundColor: p.primary, width: `${dlPercent}%` }]}
                />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                <Text style={{ color: p.subtext, fontSize: 12 }}>
                  {dlPhase === 'extracting' ? '설치 중' : '다운로드 중'} {dlPercent}%
                </Text>
                <TouchableOpacity
                  onPress={cancelModelDownload}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="다운로드 취소"
                >
                  <Text style={{ color: p.subtext, fontSize: 12, fontWeight: '700' }}>취소</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {dlError && (
            <Text style={{ color: '#e05555', fontSize: 12, marginTop: 6 }}>{dlError}</Text>
          )}
          {modelState === 'ready' && (
            <TouchableOpacity
              onPress={confirmDeleteModel}
              hitSlop={8}
              style={{ marginTop: 6, alignSelf: 'flex-start' }}
              accessibilityRole="button"
              accessibilityLabel="오프라인 음성 데이터 삭제"
            >
              <Text style={{ color: p.subtext, fontSize: 12, textDecorationLine: 'underline' }}>
                음성 데이터 삭제
              </Text>
            </TouchableOpacity>
          )}
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
          : isSherpa
            ? ' 고품질 오프라인은 약 3×까지 반영됩니다(그 이상 빠르게는 지원하지 않아요).'
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

      <TouchableOpacity
        onPress={() => preview()}
        style={[styles.previewBtn, { backgroundColor: p.primary }]}
        accessibilityRole="button"
        accessibilityLabel="현재 설정으로 미리듣기"
      >
        <Text style={{ color: p.onPrimary, fontWeight: '800', fontSize: 15 }}>🔊 현재 설정으로 미리듣기</Text>
      </TouchableOpacity>
      {previewFail && (
        <Text style={{ color: p.subtext, fontSize: 12, marginTop: 6, textAlign: 'center' }}>
          미리듣기에 실패했습니다 —{' '}
          {isEdge
            ? '인터넷 연결을 확인해주세요.'
            : isSherpa
              ? '오프라인 음성 데이터 설치 상태를 확인해주세요.'
              : '기기 TTS 설정을 확인해주세요.'}
        </Text>
      )}

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
            accessibilityRole="button"
            accessibilityLabel="기본 음성"
            accessibilityState={{ selected: !selectedVoiceId }}
          >
            <Text style={{ color: p.text, fontWeight: '600' }}>기본 음성</Text>
          </TouchableOpacity>
          {langVoices.map((v) => {
            const active = selectedVoiceId === v.id;
            const hq = isEdge || isSherpa || isHiQuality(v.quality);
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
                  accessibilityRole="button"
                  accessibilityLabel={`음성 ${v.name} 선택`}
                  accessibilityState={{ selected: active }}
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
                  accessibilityRole="button"
                  accessibilityLabel={`음성 ${v.name} 미리듣기`}
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
  dlBar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  dlFill: { height: '100%', borderRadius: 3 },
  version: { textAlign: 'center', marginTop: 32, fontSize: 12 },
});
