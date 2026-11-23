import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ParsedCookieImport } from '@/lib/cookie-parser';
import { CookieImporter } from './cookie-importer';

function Harness() {
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<ParsedCookieImport | null>(null);
  return (
    <div>
      <CookieImporter
        platform="codeforces"
        rawValue={raw}
        onChange={(nextRaw, nextParsed) => {
          setRaw(nextRaw);
          setParsed(nextParsed);
        }}
      />
      <output data-testid="normalized">{parsed?.normalizedHeader ?? ''}</output>
    </div>
  );
}

describe('CookieImporter', () => {
  it('parses Netscape cookies.txt, normalizes to single-line header, and never renders raw secret values', () => {
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

    expect(screen.getByTestId('normalized').textContent).toBe(`JSESSIONID=${secretVal}; 39ce7=abc123`);
    expect(screen.getByText('JSESSIONID=•••')).toBeTruthy();
    expect(screen.getByText('39ce7=•••')).toBeTruthy();
    expect(screen.getByText(/已自动过滤 1 个无关域名键/)).toBeTruthy();
    // Diagnostics summary and masked chip list must NOT echo secret values
    const summaryEl = screen.getByText(/已识别：Netscape cookies\.txt/).closest('div.rounded-\\[3px\\]')!;
    expect(summaryEl.textContent).not.toContain(secretVal);

    // Clearing resets normalized value cleanly
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByTestId('normalized').textContent).toBe('');
  });
});
