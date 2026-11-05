import { HttpException, Logger } from '@nestjs/common';
import { env } from '../config.js';

type AiInit = RequestInit & { timeoutMs?: number };
const log = new Logger('AI');

/** A readable error from the AI service's JSON body ({message} from our routes, {detail} from FastAPI). */
function aiError(body: Record<string, unknown>, status: number) {
  const detail = body.detail;
  const message = (body.message as string) ?? (typeof detail === 'string' ? detail : status === 422 ? 'That request couldn’t be processed.' : undefined);
  return new HttpException({ ...body, message: message ?? 'The AI service had a problem.' }, status);
}

/** Server-to-server call to the AI service, authenticated with the shared internal key. */
export async function callAiRaw(path: string, { timeoutMs = 8000, ...init }: AiInit = {}): Promise<Response> {
  const headers: Record<string, string> = { 'x-internal-key': env.internalApiKey, ...(init.headers as Record<string, string> | undefined) };
  if (typeof init.body === 'string') headers['content-type'] ??= 'application/json';
  let res: Response;
  try {
    res = await fetch(`${env.aiServiceUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new HttpException({ message: 'Pip is taking a break right now. Please try again in a moment.' }, 503);
  }
  if (res.ok) return res;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // The AI service refused our internal key: a setup problem, not the shopper's session. Passed on as a
  // 401, it would sign shoppers out (the storefront treats any 401 as an expired session).
  if (res.status === 401 || res.status === 403) {
    log.error(`The AI service answered ${res.status} to ${path}: set the same INTERNAL_API_KEY for the API and the AI service.`);
    throw new HttpException({ message: 'The AI service had a problem.' }, 502);
  }
  throw aiError(body, res.status);
}

export async function callAi<T = Record<string, unknown>>(path: string, init: AiInit = {}): Promise<T> {
  return (await (await callAiRaw(path, init)).json()) as T;
}

const OFF = { agent: null, multilingual: false, tryon: null, speech: { stt: null, tts: null } };
let capabilities: { until: number; value: Promise<unknown> } | undefined;

/**
 * What the AI service can do right now (all off when it's unreachable). Every storefront visit asks,
 * so each API instance keeps the answer for 30 seconds (5 while the AI service is down).
 */
export function aiCapabilities() {
  if (capabilities && capabilities.until > Date.now()) return capabilities.value;
  const entry = { until: Date.now() + 30_000, value: Promise.resolve(OFF as unknown) };
  entry.value = callAi('/capabilities', { timeoutMs: 2500 }).catch(() => {
    entry.until = Date.now() + 5_000;
    return OFF;
  });
  capabilities = entry;
  return entry.value;
}
