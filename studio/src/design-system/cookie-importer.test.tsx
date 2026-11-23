import { useMemo, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseOjCookieInput } from '@/lib/cookie-parser';
import { CookieImporter } from './cookie-importer';

function Harness() {
  const [raw, setRaw] = useState('');
  const parsed = useMemo(() => parseOjCookieInput(raw, 'codeforces'), [raw]);
  return (
    <div>
      <CookieImporter platform="codeforces" rawValue={raw} onRawChange={setRaw} />
      <output data-testid="normalized">{parsed?.normalizedHeader ?? ''}</output>
    </div>
  );
}

describe('CookieImporter', () => {
  it('parses Netscape cookies.txt, masks raw value immediately, and clears cleanly', () => {
    render(<Harness />);
    const secretVal = 'SUPER_SECRET_CF_SESSION_999';
    const netscape = [
      '# Netscape HTTP Cookie File',
      `#HttpOnly_.codeforces.com\tTRUE\t/\tTRUE\t2147483647\tJSESSIONID\t${secretVal}`,
      `.codeforces.com\tTRUE\t/\tFALSE\t2147483647\t39ce7\tabc123`,
      `.google.com\tTRUE\t/\tFALSE\t2147483647\tNID\tignored_domain`,
    ].join('\n');

    const input = screen.getByLabelText('登录 Cookie（只写不读）');
    fireEvent.change(input, { target: { value: netscape } });

    // Normalized header derived from current props matches expected value
    expect(screen.getByTestId('normalized').textContent).toBe(`JSESSIONID=${secretVal}; 39ce7=abc123`);
    // Raw textarea is immediately replaced by masked summary card so secret is NOT visible in DOM
    expect(screen.queryByLabelText('登录 Cookie（只写不读）')).toBeNull();
    expect(screen.getByText(/已暂存脱敏 Cookie/)).toBeTruthy();
    expect(screen.getByText('JSESSIONID=•••')).toBeTruthy();
    expect(screen.getByText('39ce7=•••')).toBeTruthy();
    expect(screen.getByText(/已自动过滤 1 个无关域名键/)).toBeTruthy();

    // Clearing resets normalized value and restores empty input cleanly
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByTestId('normalized').textContent).toBe('');
    expect((screen.getByLabelText('登录 Cookie（只写不读）') as HTMLTextAreaElement).value).toBe('');
  });
});
