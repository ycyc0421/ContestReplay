// Provider credentials should not appear in artifacts even if an upstream
// reflects its Authorization header in model output or diagnostics.
export function credentialJson(value: unknown, key?: string, space?: number) {
  return JSON.stringify(value, (_field, item) => typeof item === 'string' && key && (item === key || key.length >= 8)
    ? item.replaceAll(key, '[REDACTED]') : item, space);
}

export function redactCredentialStream(key: string | undefined, write: (bytes: Buffer) => void) {
  if (!key) return { push: write, end: () => {} };
  const needle = Buffer.from(key);
  let pending = Buffer.alloc(0);
  const replace = Buffer.from('[REDACTED]');
  return {
    push(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      // Preserve live output; hold back only a possible partial match.
      let match: number;
      while ((match = pending.indexOf(needle)) !== -1) {
        write(pending.subarray(0, match));
        write(replace);
        pending = pending.subarray(match + needle.length);
      }
      let keep = Math.min(needle.length - 1, pending.length);
      while (keep && !pending.subarray(pending.length - keep).equals(needle.subarray(0, keep))) keep--;
      write(pending.subarray(0, pending.length - keep));
      pending = Buffer.from(pending.subarray(pending.length - keep));
    },
    end() {
      // If the harness is stopped mid-write, discard a sufficiently long prefix.
      if (pending.length) write(pending.length >= 8 ? replace : pending);
      pending = Buffer.alloc(0);
    },
  };
}
