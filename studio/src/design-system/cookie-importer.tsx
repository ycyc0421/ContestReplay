import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, HelpCircle, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseOjCookieInput, type OjPlatformKind } from '@/lib/cookie-parser';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/fields';

export interface CookieImporterProps {
  label?: string;
  platform: OjPlatformKind;
  baseUrl?: string;
  rawValue: string;
  onRawChange: (raw: string) => void;
}

/**
 * Multi-format write-only OJ Cookie importer.
 * - Derives parsed diagnostics strictly from current (rawValue, platform, baseUrl) props.
 * - Discards stale async file reads on Clear, paste, or destination changes.
 * - Consumes pasted/imported cookies into a masked write-only card so raw credentials
 *   are not visibly displayed in the dialog.
 */
export function CookieImporter({
  label = '登录 Cookie（只写不读）',
  platform,
  baseUrl,
  rawValue,
  onRawChange,
}: CookieImporterProps) {
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const readGenRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [sealed, setSealed] = useState(false);

  const parsed = useMemo(
    () => parseOjCookieInput(rawValue, platform, baseUrl),
    [rawValue, platform, baseUrl],
  );

  // Invalidate any in-flight file read when destination changes, and unseal if cleared.
  useEffect(() => {
    readGenRef.current += 1;
  }, [platform, baseUrl]);

  useEffect(() => {
    if (!rawValue) setSealed(false);
  }, [rawValue]);

  const clearInput = () => {
    readGenRef.current += 1;
    setSealed(false);
    onRawChange('');
  };

  const applyRaw = (nextRaw: string, shouldSealIfValid: boolean) => {
    readGenRef.current += 1;
    onRawChange(nextRaw);
    if (!nextRaw.trim()) {
      setSealed(false);
      return;
    }
    if (shouldSealIfValid) {
      const candidate = parseOjCookieInput(nextRaw, platform, baseUrl);
      if (candidate?.normalizedHeader) setSealed(true);
    }
  };

  const readFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 512 * 1024) return;
    const gen = ++readGenRef.current;
    const text = await file.text();
    if (readGenRef.current !== gen) return;
    onRawChange(text);
    const candidate = parseOjCookieInput(text, platform, baseUrl);
    setSealed(Boolean(candidate?.normalizedHeader));
  };

  const healthy = Boolean(
    parsed &&
    parsed.keys.length > 0 &&
    parsed.originStatus !== 'mismatched' &&
    parsed.missingRecommendedKeys.length === 0,
  );
  const isMaskedLoaded = sealed && Boolean(parsed?.normalizedHeader);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.json,text/plain,application/json"
            className="hidden"
            onChange={event => {
              void readFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
            <FileUp className="size-3.5" />导入文件
          </Button>
          {rawValue && (
            <Button type="button" variant="ghost" size="sm" onClick={clearInput}>
              <Trash2 className="size-3.5" />清空
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowGuide(v => !v)}>
            <HelpCircle className="size-3.5" />获取方式
          </Button>
        </div>
      </div>

      {isMaskedLoaded ? (
        <div
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => {
            event.preventDefault();
            setDragging(false);
            void readFile(event.dataTransfer.files[0]);
          }}
          className={cn(
            'flex items-center justify-between gap-3 rounded-[3px] border border-primary/30 bg-muted/25 px-3.5 py-3 text-xs',
            dragging && 'ring-2 ring-primary/50',
          )}
        >
          <div className="flex items-center gap-2 text-foreground">
            <Lock className="size-3.5 shrink-0 text-primary" />
            <span>已暂存脱敏 Cookie（原文已隐藏，保存后写入本机只写凭据库）</span>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={clearInput}>
            <RefreshCw className="size-3.5" />重新粘贴
          </Button>
        </div>
      ) : (
        <div
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => {
            event.preventDefault();
            setDragging(false);
            void readFile(event.dataTransfer.files[0]);
          }}
          className={cn('rounded-[3px] transition-colors', dragging && 'ring-2 ring-primary/50')}
        >
          <Textarea
            id={inputId}
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            value={rawValue}
            style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
            onChange={event => {
              const next = event.target.value;
              const bulkInsert = next.length - rawValue.length >= 4;
              applyRaw(next, bulkInsert);
            }}
            onBlur={() => {
              if (parsed?.normalizedHeader) setSealed(true);
            }}
            className="min-h-24 font-mono text-xs leading-5"
            placeholder="直接粘贴或拖入 cookies.txt (Netscape)、DevTools Copy as cURL、Cookie-Editor JSON，或单行 Cookie 请求头 (key=value; ...)"
          />
        </div>
      )}

      {parsed ? (
        <div
          className={cn(
            'rounded-[3px] border px-3.5 py-2.5 text-xs leading-5',
            healthy
              ? 'border-primary/30 bg-primary/5'
              : 'border-warning/40 bg-warning/5',
          )}
        >
          <div className="flex items-start gap-2">
            {healthy ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <div>
                <span className="font-medium">已识别：{parsed.formatLabel}</span>
                <span className="mx-1.5 text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {parsed.originStatus === 'matched' ? (
                    <>
                      匹配 <span className="font-mono">{parsed.targetDomain}</span> 共 {parsed.keys.length} 个键
                      {parsed.filteredOutCount > 0 ? `（已自动过滤 ${parsed.filteredOutCount} 个无关域名键）` : ''}
                    </>
                  ) : parsed.originStatus === 'mismatched' ? (
                    <>来源域 <span className="font-mono">{parsed.sourceOrigin}</span> 与目标 <span className="font-mono">{parsed.targetOrigin}</span> 不一致</>
                  ) : (
                    <>
                      共 {parsed.keys.length} 个键（无来源域元数据，将发送至 <span className="font-mono">{parsed.targetOrigin}</span>）
                    </>
                  )}
                </span>
              </div>
              {parsed.keys.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {parsed.keys.slice(0, 12).map(key => (
                    <span
                      key={key}
                      className="inline-flex items-center rounded-[2px] border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                    >
                      {key}=•••
                    </span>
                  ))}
                  {parsed.keys.length > 12 && (
                    <span className="font-mono text-[10px] text-muted-foreground">+{parsed.keys.length - 12} 项</span>
                  )}
                </div>
              )}
              {parsed.missingRecommendedKeys.length > 0 && parsed.originStatus !== 'mismatched' && (
                <p className="text-warning">
                  提示：未检测到常见登录会话键 <span className="font-mono">{parsed.missingRecommendedKeys.join(', ')}</span>，提交时可能提示未登录。
                </p>
              )}
              {parsed.warnings.map(warning => (
                <p key={warning} className="text-warning">{warning}</p>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[11px] leading-5 text-muted-foreground">
          本地实时解析并规范化为标准 Cookie 请求头；粘贴后自动隐藏明文，仅写入本机只写凭据库。
        </p>
      )}

      {showGuide && (
        <div className="rounded-[3px] border bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <div className="mb-1.5 font-medium text-foreground">推荐获取方式（任选其一）</div>
          <ol className="list-decimal space-y-1 pl-4">
            <li>使用浏览器插件导出当前站点的 <span className="font-mono">cookies.txt</span>（Netscape 格式）或 JSON，直接拖入/粘贴到上方。</li>
            <li>或在已登录页面按 <span className="font-mono">F12 → Network</span>，右键任意本站请求选择 <span className="font-mono">Copy as cURL</span> 直接粘贴。</li>
            <li>亦可直接复制请求头中的单行 <span className="font-mono">Cookie: ...</span> 字段值。</li>
          </ol>
        </div>
      )}
    </div>
  );
}
