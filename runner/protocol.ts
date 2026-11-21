import { sha256 } from './config.js';

export const protocol = Object.freeze({
  id: 'responses-pdf-mcp', version: 1, timeLimitMs: 15 * 60_000, requestTimeoutMs: 180_000,
  maxTurns: 32, maxSubmissions: 100, maxOutputTokens: 4096,
  pdfInput: 'native-inline-pdf', parallelToolCalls: false,
  instructions: 'You are competing in this contest. Read the complete attached PDF, including its diagrams. Choose the problems and order yourself. Use submit with the exact problem ID as printed and your final answer. Only submissions are scored. Use finish when done. No external resources are allowed.',
  tools: ['submit', 'status', 'finish'],
  codex: { id: 'codex-pdf-pages-mcp', renderer: 'Poppler PNG, long edge 1600; 1–32 pages', tools: ['submit', 'status', 'finish'], settlementMs: 120_000 },
});

export const toolDefinitions = [
  { type: 'function', name: 'submit', description: 'Submit a final answer for one problem.', strict: true,
    parameters: { type: 'object', properties: { problem_id: { type: 'string' }, answer: { type: 'string' } }, required: ['problem_id', 'answer'], additionalProperties: false } },
  { type: 'function', name: 'status', description: 'Read a submission verdict or remaining time and accepted problems.', strict: true,
    parameters: { type: 'object', properties: { submission_id: { type: ['string', 'null'] } }, required: ['submission_id'], additionalProperties: false } },
  { type: 'function', name: 'finish', description: 'End the contest and close submissions.', strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
] as const;

export const protocolDigest = sha256(JSON.stringify({ protocol, toolDefinitions }));
