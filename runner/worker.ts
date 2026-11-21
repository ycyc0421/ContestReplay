import { open } from 'node:fs/promises';
import { frames, send } from './wire.js';

// Built-in adapter: sandbox-side turn loop. The supervisor owns PDF delivery,
// provider requests, scoring and the mapping from call indexes to MCP tools.
try {
  const pdf = await open('/inputs/problems.pdf', 'r');
  try {
    const header = Buffer.alloc(5);
    await pdf.read(header, 0, header.length, 0);
    if (header.toString() !== '%PDF-') throw new Error('Missing staged PDF');
  } finally { await pdf.close(); }
  const reply = frames(process.stdin);
  await send(process.stdout, { op: 'ready' });
  for (;;) {
    await send(process.stdout, { op: 'next' });
    const frame = (await reply.next()).value as { done?: boolean; calls?: number } | undefined;
    if (frame?.done === true) break;
    if (typeof frame?.calls !== 'number' || !Number.isInteger(frame.calls) || frame.calls < 1 || frame.calls > 128) throw new Error('Invalid turn');
    for (let index = 0; index < frame.calls; index++) {
      await send(process.stdout, { op: 'tool', index });
      const result = (await reply.next()).value as { done?: boolean } | undefined;
      if (result?.done === true) { process.stdin.destroy(); break; }
      if (result?.done !== false) throw new Error('Invalid tool acknowledgement');
    }
    if (process.stdin.destroyed) break;
  }
  await reply.return(undefined);
  process.stdin.destroy();
} catch {
  process.stderr.write('Bench worker protocol error\n');
  process.exitCode = 1;
  process.stdin.destroy();
}
