import { useColorScheme } from 'react-native';

export type Palette = {
  bg: string;
  surface: string;
  card: string;
  text: string;
  subtext: string;
  faint: string;
  primary: string;
  onPrimary: string;
  highlight: string;      // 현재 읽는 단어 배경
  highlightText: string;
  border: string;
  danger: string;
};

const light: Palette = {
  bg: '#f7f7fb',
  surface: '#ffffff',
  card: '#ffffff',
  text: '#15151b',
  subtext: '#5a5a6b',
  faint: '#b7b7c4',
  primary: '#6366f1',
  onPrimary: '#ffffff',
  // 읽는 단어 하이라이트: 브랜드(인디고) 계열의 은은한 배경 — 샛노란색은 촌스럽다는
  // 사용자 피드백(2026-07-08)으로 교체. 본문 대비는 진한 인디고 글자로 확보.
  highlight: '#e0e7ff',
  highlightText: '#3730a3',
  border: '#e6e6ee',
  danger: '#e5484d',
};

const dark: Palette = {
  bg: '#0e0e13',
  surface: '#17171f',
  card: '#1c1c26',
  text: '#f2f2f7',
  subtext: '#a9a9ba',
  faint: '#55556a',
  primary: '#818cf8',
  onPrimary: '#10101a',
  // 다크에서도 주황/노랑 대신 인디고 계열(라이트와 동일 방침).
  highlight: '#4338ca',
  highlightText: '#eef2ff',
  border: '#2a2a36',
  danger: '#ff6b6f',
};

export function usePalette(): Palette {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}
