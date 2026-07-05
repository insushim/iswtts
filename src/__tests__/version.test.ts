import { compareVersions } from '../lib/version';

describe('compareVersions', () => {
  it('최신이 크면 1', () => {
    expect(compareVersions('1.2.0', '1.3.0')).toBe(1);
    expect(compareVersions('1.2.0', '2.0.0')).toBe(1);
    expect(compareVersions('1.2.0', '1.2.1')).toBe(1);
  });
  it('현재가 크면 -1', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBe(-1);
  });
  it('같으면 0 (v 접두사·자릿수 부족 허용)', () => {
    expect(compareVersions('1.2.0', 'v1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
  it('두 자리 마이너/패치 숫자 비교(사전순 아님)', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(1);
  });
});
