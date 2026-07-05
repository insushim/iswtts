import { stripTagBlocks } from '../lib/html';

// 기존 O(n²) 정규식과의 동등성 기준(정상 입력) + 악성 입력 선형성.
const legacy = (s: string, tag: string) =>
  s.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');

describe('stripTagBlocks', () => {
  const cases = [
    '<p>a</p><script>var x=1;</script><p>b</p>',
    'no tags at all',
    '<SCRIPT type="x">y</SCRIPT>after',
    '<script>a</script><script>b</script>tail',
    '<scripts>not-a-script</scripts>',
    '<script>unclosed rest of doc',
    'pre<style>.a{}</style>post',
    '',
  ];

  it.each(cases)('기존 정규식과 결과 동등: %j', (c) => {
    expect(stripTagBlocks(stripTagBlocks(c, 'script'), 'style')).toBe(
      legacy(legacy(c, 'script'), 'style'),
    );
  });

  it('악성 입력(unclosed <script> 20만 반복)도 1초 이내(선형)', () => {
    const evil = '<script>'.repeat(200_000);
    const t0 = Date.now();
    stripTagBlocks(evil, 'script');
    expect(Date.now() - t0).toBeLessThan(1000); // 기존 정규식은 실측 50.7초
  });
});
