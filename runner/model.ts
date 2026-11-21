import OpenAI from 'openai';
import type { ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses.js';
import { protocol, toolDefinitions } from './protocol.js';
import type { Inputs } from './config.js';

export type Turn = { output: ResponseOutputItem[]; model: string; requestId?: string | null; responseId?: string; usage?: unknown; status?: string; incompleteReason?: string };
export type Infer = (input: ResponseInput, signal: AbortSignal) => Promise<Turn>;
export function createInference(apiKey: string, profile: Extract<Inputs['profile'], { harness: 'builtin-responses' }>, limits?: { requestTimeoutMs?: number; maxOutputTokens?: number }): Infer {
  const maxOutputTokens = limits?.maxOutputTokens ?? protocol.maxOutputTokens;
  const client = new OpenAI({ apiKey, baseURL: profile.base_url, logLevel: 'off', maxRetries: 0, timeout: limits?.requestTimeoutMs ?? protocol.requestTimeoutMs,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  return async (input, signal) => {
    const response = await client.responses.create({ model: profile.model, input, instructions: protocol.instructions,
      tools: toolDefinitions.map(tool => ({ ...tool })), parallel_tool_calls: false, temperature: profile.temperature,
      max_output_tokens: maxOutputTokens, store: false, truncation: 'disabled', stream: false }, { signal });
    return { output: response.output, model: response.model, requestId: response._request_id, responseId: response.id,
      usage: response.usage, status: response.status, incompleteReason: response.incomplete_details?.reason };
  };
}
