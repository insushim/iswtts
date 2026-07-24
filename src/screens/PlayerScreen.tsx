import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePalette } from '../lib/theme';
import { splitHighlight } from '../lib/highlight';
import { clamp01, indexToPct, pctToIndex } from '../lib/scrub';
import {
  autoScrollTarget,
  hideNeighbors,
  lineScrollTarget,
  shouldScroll,
  subtitleShrink,
  type SubtitleLine,
} from '../lib/subtitleLayout';
import { RATE_MIN, RATE_MAX, stepRateValue } from '../lib/rateSteps';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { useSettings } from '../store/settings';
import type { RootStackParamList } from '../../App';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

// ── 컨트롤 아이콘(순수 View — 이모지 글리프는 기기·폰트마다 모양이 제각각이고 촌스럽다는
// 피드백(2026-07-08)으로 교체. 아이콘 폰트 의존성 없이 도형으로 그린다) ─────────────
function PlayIcon({ color, size = 26 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: 0,
        height: 0,
        marginLeft: size * 0.18, // 삼각형 무게중심 보정(원 안에서 시각적 중앙)
        borderTopWidth: size * 0.58,
        borderBottomWidth: size * 0.58,
        borderLeftWidth: size,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderLeftColor: color,
      }}
    />
  );
}

function PauseIcon({ color, size = 26 }: { color: string; size?: number }) {
  const bar = { width: size * 0.28, height: size, borderRadius: size * 0.14, backgroundColor: color };
  return (
    <View style={{ flexDirection: 'row', gap: size * 0.28 }}>
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

function SkipIcon({ color, dir, size = 18 }: { color: string; dir: -1 | 1; size?: number }) {
  const tri = {
    width: 0,
    height: 0,
    borderTopWidth: size * 0.5,
    borderBottomWidth: size * 0.5,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    ...(dir === 1
      ? { borderLeftWidth: size * 0.8, borderLeftColor: color }
      : { borderRightWidth: size * 0.8, borderRightColor: color }),
  } as const;
  return (
    <View style={{ flexDirection: dir === 1 ? 'row' : 'row-reverse', alignItems: 'center', gap: 2.5 }}>
      <View style={tri} />
      <View style={{ width: size * 0.18, height: size, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

export default function PlayerScreen({ route, navigation }: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { docId } = route.params;

  const player = usePlayer();
  const fontScale = useSettings((s) => s.fontScale);
  const rate = useSettings((s) => s.rate);
  const setSettings = useSettings((s) => s.set);
  const loadDoc = useLibrary((s) => s.loadDoc);
  const docs = useLibrary((s) => s.docs);
  const [loading, setLoading] = useState(true);
  // 진행 바 스크럽 상태: 드래그 중인 목표 위치(0..1). null = 드래그 아님(실제 진행률 표시).
  const [scrub, setScrub] = useState<number | null>(null);
  const [trackW, setTrackW] = useState(0);

  // 문서 로드
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const doc = docs.find((d) => d.id === docId);
        const { sentences, paraStarts } = await loadDoc(docId);
        if (!alive) return;
        usePlayer.getState().load({
          docId,
          title: doc?.title || '읽기',
          sentences,
          paraStarts,
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

  // 재생 중 화면 켜두기 (+ 언마운트 시 해제 — 없으면 화면을 나가도 계속 깨어 있어 배터리 소모)
  useEffect(() => {
    if (player.playing) activateKeepAwakeAsync('iwtts');
    else deactivateKeepAwake('iwtts');
  }, [player.playing]);
  useEffect(() => {
    return () => {
      deactivateKeepAwake('iwtts');
    };
  }, []);

  // 재생 실패·폴백 알림 배너 — 5초 뒤 자동 소멸.
  const notice = player.notice;
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => usePlayer.getState().setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const { sentences, index, wordStart, wordLen, playing } = player;
  const cur = sentences[index] || '';
  const prev = index > 0 ? sentences[index - 1] : '';
  const nextS = index < sentences.length - 1 ? sentences[index + 1] : '';

  // 긴 문장(대사 한 덩어리 등)은 글자를 단계적으로 줄여 되도록 스크롤 없이 담는다
  // (subtitleLayout.ts — 그래도 넘치면 아래 자동 스크롤이 하이라이트를 따라간다).
  const bigSize = Math.round(26 * fontScale * subtitleShrink(cur.length));
  const bigLineH = Math.round(bigSize * 1.54);
  // 긴 문장일 때는 이웃 자막(이전·다음)을 감춰 현재 문장에 자리를 몰아준다.
  const roomy = hideNeighbors(cur.length);
  const smallSize = Math.round(16 * fontScale);

  // 현재 문장을 [앞 · 하이라이트 단어 · 뒤]로 분해
  const { before, word, after } = splitHighlight(cur, wordStart, wordLen);

  // ── 자막 자동 스크롤: 한 화면을 넘는 문장에서 하이라이트를 따라간다 ─────────
  const stageRef = useRef<ScrollView>(null);
  const [viewH, setViewH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const scrollY = useRef(0);
  // 줄 정보는 ref 에 담는다 — state 로 두면 onTextLayout → 리렌더 → 재측정 루프가 된다.
  const linesRef = useRef<SubtitleLine[]>([]);

  // 손으로 스크롤한 동안에는 자동 추적을 멈춘다(읽던 위치를 뺏지 않게) — 문장이 바뀌면 해제.
  const userScrolled = useRef(false);

  // 문장이 바뀌면 처음부터.
  useEffect(() => {
    scrollY.current = 0;
    userScrolled.current = false;
    // 이전 문장의 줄 정보를 비운다 — 새 문장의 onTextLayout 이 도착하기 전까지 그걸 쓰면
    // 엉뚱한 줄로 스크롤한다(길이 검사가 대부분 걸러 주지만 우연히 비슷하면 통과한다).
    linesRef.current = [];
    stageRef.current?.scrollTo({ y: 0, animated: false });
  }, [index]);

  useEffect(() => {
    if (userScrolled.current) return;
    // 줄 정보(onTextLayout)가 있으면 "몇 번째 줄"로, 없으면 글자 수 비례로.
    const target =
      lineScrollTarget({
        lines: linesRef.current,
        charIndex: wordStart,
        textLen: cur.length,
        contentH,
        viewH,
      }) ??
      autoScrollTarget({
        charIndex: wordStart,
        charLen: wordLen,
        textLen: cur.length,
        contentH,
        viewH,
      });
    // 단어마다 몇 px 씩 흔들리지 않게 문턱을 넘을 때만(shouldScroll).
    if (!shouldScroll(scrollY.current, target, viewH)) return;
    scrollY.current = target;
    stageRef.current?.scrollTo({ y: target, animated: true });
  }, [wordStart, wordLen, cur.length, contentH, viewH]);

  // 배속 눈금은 lib/rateSteps.ts 단일 진실원(1~2×는 0.1 간격 — v1.25.1).

  // ── 진행 바 시킹: 탭/드래그로 문장 위치 이동(2026-07-08 사용자 요청) ─────────
  // 표시와 시킹은 반드시 같은 위치 공식(lib/scrub.ts) — 다르면 놓는 순간 바가 튄다.
  const pctFromX = (x: number) => (trackW > 0 ? clamp01(x / trackW) : 0);
  const onScrubEnd = (pct: number) => {
    setScrub(null);
    if (sentences.length) player.seek(pctToIndex(pct, sentences.length));
  };
  // 표시 진행률: 드래그 중엔 손가락 위치, 평소엔 실제 진행.
  const progressPct = indexToPct(index, sentences.length);
  const fillPct = scrub ?? progressPct;
  const rateMin = RATE_MIN;
  const rateMax = RATE_MAX;
  // 재생 중 배속 +/- (양방향, 순환 없음 — 끝에서 멈춘다). 예전 단일 순환 버튼은 10× 다음이
  // 0.5× 로 급락(랩)해, 그 0.5× 저속 합성이 직렬 큐를 막아 "10배속 갔다 1배속 오면 멈춤"의
  // 방아쇠였다(실측 2026-07-16). 이제 −/+ 로 인접 단계만 이동해 그 함정을 원천 차단한다.
  const stepRate = (dir: 1 | -1) => {
    const next = stepRateValue(rate, dir);
    if (next === rate) return;
    setSettings({ rate: next });
    // 재생 중이면 즉시 반영 — 가능하면 라이브(끊김 0), 불가하면 현재 문장 재발화.
    usePlayer.getState().applyRate(next);
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
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="목록으로 돌아가기"
        >
          <Text style={[styles.back, { color: p.subtext }]}>‹ 목록</Text>
        </TouchableOpacity>
        <Text style={[styles.count, { color: p.subtext }]}>
          {sentences.length ? index + 1 : 0} / {sentences.length}
          {sentences.length ? ` (${Math.round(progressPct * 100)}%)` : ''}
        </Text>
      </View>

      {/* 자막 영역: 이전(흐림) · 현재(중앙 크게) · 다음(흐림) */}
      <View style={styles.stage}>
        {!!prev && !roomy && (
          <Text
            style={[styles.neighbor, { color: p.faint, fontSize: smallSize }]}
            numberOfLines={2}
          >
            {prev}
          </Text>
        )}

        {/* 현재 문장: 남는 공간 안에서만 자란다(flexShrink) — 넘치면 스크롤. 이전엔 이 Text 가
            제 높이대로 늘어나 상단바·진행바 위로 흘러넘쳐 잘렸다(사용자 보고 2026-07-24). */}
        <ScrollView
          ref={stageRef}
          style={styles.currentScroll}
          contentContainerStyle={styles.currentScrollContent}
          showsVerticalScrollIndicator={false}
          onLayout={(e) => setViewH(e.nativeEvent.layout.height)}
          onContentSizeChange={(_w, h) => setContentH(h)}
          onScrollBeginDrag={() => {
            userScrolled.current = true;
          }}
        >
          <Text
            style={[styles.current, { fontSize: bigSize, lineHeight: bigLineH, color: p.text }]}
            onTextLayout={(e) => {
              linesRef.current = e.nativeEvent.lines as SubtitleLine[];
            }}
          >
            {before}
            {!!word && (
              <Text
                style={{
                  color: p.highlightText,
                  backgroundColor: p.highlight,
                  // ⚠️ fontWeight 를 문장('700')과 다르게 주지 말 것 — 굵기가 다르면 글자 폭이
                  // 변해 하이라이트가 단어를 옮겨 다닐 때마다 줄바꿈이 재계산되고, 문장 전체가
                  // 이리저리 밀리는 "배치 흔들림"이 된다(사용자 보고 2026-07-23). 강조는
                  // 배경색+글자색 대비만으로 — 글리프 폭이 완전히 동일해 레이아웃이 고정된다.
                }}
              >
                {word}
              </Text>
            )}
            {after}
          </Text>
        </ScrollView>

        {!!nextS && !roomy && (
          <Text
            style={[styles.neighbor, { color: p.faint, fontSize: smallSize }]}
            numberOfLines={2}
          >
            {nextS}
          </Text>
        )}
      </View>

      {/* 재생 실패·폴백 알림 배너 */}
      {!!notice && (
        <View style={[styles.notice, { backgroundColor: p.border }]}>
          <Text style={[styles.noticeText, { color: p.text }]}>{notice}</Text>
        </View>
      )}

      {/* 진행 바 — 탭/드래그로 원하는 위치(문장)로 이동. 드래그 중엔 목표 %·문장 번호 표시. */}
      {scrub != null && (
        <View style={styles.scrubBadgeRow} pointerEvents="none">
          <View style={[styles.scrubBadge, { backgroundColor: p.primary }]}>
            <Text style={[styles.scrubBadgeText, { color: p.onPrimary }]}>
              {Math.round(scrub * 100)}% · {pctToIndex(scrub, sentences.length) + 1}번째 문장
            </Text>
          </View>
        </View>
      )}
      <View
        style={styles.trackTouch}
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => setScrub(pctFromX(e.nativeEvent.locationX))}
        onResponderMove={(e) => setScrub(pctFromX(e.nativeEvent.locationX))}
        onResponderRelease={(e) => onScrubEnd(pctFromX(e.nativeEvent.locationX))}
        onResponderTerminate={() => setScrub(null)}
        accessibilityRole="adjustable"
        accessibilityLabel="진행 위치. 좌우로 끌거나 탭해서 이동"
      >
        <View style={[styles.track, { backgroundColor: p.border }]} pointerEvents="none">
          <View style={[styles.fill, { backgroundColor: p.primary, width: `${fillPct * 100}%` }]} />
        </View>
        <View
          style={[styles.thumb, { backgroundColor: p.primary, left: `${fillPct * 100}%` }]}
          pointerEvents="none"
        />
      </View>

      {/* 배속 스테퍼 (−/값/+): 재생 중에도 양방향 조절, 끝에서 멈춤 */}
      <View style={styles.rateRow}>
        <TouchableOpacity
          onPress={() => stepRate(-1)}
          disabled={rate <= rateMin + 0.001}
          hitSlop={10}
          style={[
            styles.rateStep,
            { borderColor: p.border, backgroundColor: p.surface, opacity: rate <= rateMin + 0.001 ? 0.4 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="배속 낮추기"
        >
          <Text style={[styles.rateStepText, { color: p.text }]}>−</Text>
        </TouchableOpacity>

        <Text style={[styles.rateValue, { color: p.text }]}>{rate}×</Text>

        <TouchableOpacity
          onPress={() => stepRate(1)}
          disabled={rate >= rateMax - 0.001}
          hitSlop={10}
          style={[
            styles.rateStep,
            { borderColor: p.border, backgroundColor: p.surface, opacity: rate >= rateMax - 0.001 ? 0.4 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="배속 높이기"
        >
          <Text style={[styles.rateStepText, { color: p.text }]}>+</Text>
        </TouchableOpacity>
      </View>

      {/* 컨트롤 */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity
          onPress={() => player.prev()}
          hitSlop={10}
          style={[styles.ctrlBtn, { backgroundColor: p.surface, borderColor: p.border }]}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="이전 문장"
        >
          <SkipIcon color={p.text} dir={-1} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => player.toggle()}
          style={[styles.playBtn, { backgroundColor: p.primary, shadowColor: p.primary }]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={playing ? '일시정지' : '재생'}
        >
          {playing ? <PauseIcon color={p.onPrimary} /> : <PlayIcon color={p.onPrimary} />}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => player.next()}
          hitSlop={10}
          style={[styles.ctrlBtn, { backgroundColor: p.surface, borderColor: p.border }]}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="다음 문장"
        >
          <SkipIcon color={p.text} dir={1} />
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
  // 남는 높이 안에서만 차지한다(flexGrow 0 + flexShrink 1) — 내용이 더 크면 스크롤.
  currentScroll: { flexGrow: 0, flexShrink: 1, alignSelf: 'stretch' },
  // 짧은 문장은 영역 안에서 세로 중앙(flexGrow: 1 + center), 긴 문장은 위에서부터 채운다.
  currentScrollContent: { flexGrow: 1, justifyContent: 'center' },
  // lineHeight 는 글자 크기에 비례해 화면에서 계산(축소 시 줄 간격만 남는 것 방지).
  current: { textAlign: 'center', fontWeight: '700' },
  notice: {
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  noticeText: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  // 터치 영역은 넉넉히(높이 32), 시각적 바는 그 안에 6px — 손가락으로 잡기 쉽게.
  trackTouch: { height: 32, marginHorizontal: 20, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    top: 9,
    elevation: 2,
  },
  scrubBadgeRow: { alignItems: 'center', marginBottom: 6 },
  scrubBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  scrubBadgeText: { fontSize: 13, fontWeight: '700' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    paddingTop: 20,
  },
  ctrlBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  rateStep: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateStepText: { fontSize: 26, fontWeight: '600', lineHeight: 30 },
  rateValue: {
    fontSize: 18,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 64,
    textAlign: 'center',
  },
});
