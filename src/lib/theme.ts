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
  highlight: '#fde68a',
  highlightText: '#3b2f00',
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
  highlight: '#b45309',
  highlightText: '#fff7e6',
  border: '#2a2a36',
  danger: '#ff6b6f',
};

export function usePalette(): Palette {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}
