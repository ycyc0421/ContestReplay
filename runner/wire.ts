import type { Readable, Writable } from 'node:stream';

export async function* frames(stream: Readable): AsyncGenerator<unknown> {
  stream.setEncoding('utf8');
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk;
    let i: number;
    while ((i = pending.indexOf('\n')) !== -1) {
      if (i > 16_384) throw new Error('IPC frame exceeds limit');
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      yield JSON.parse(line);
    }
    if (pending.length > 16_384) throw new Error('IPC frame exceeds limit');
  }
  if (pending.length) throw new Error('Truncated IPC frame');
}

export async function send(stream: Writable, frame: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(JSON.stringify(frame) + '\n', error => error ? reject(error) : resolve());
  });
}
