import { createHmac } from 'node:crypto';
import { isIPv6 } from 'node:net';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Ip,
  Module,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { type AuthUser, CurrentUser, JwtAuthGuard, OptionalAuthGuard } from '../common/auth.js';
import { aiCapabilities, callAi, callAiRaw } from '../common/ai.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
/** Bytes of JSON. The storefront's context is about 1 KB; a full fitting room with the longest names still fits. */
const CONTEXT_MAX = 4096;

export class ChatDto {
  /** What the shopper said or typed. Not needed for `kind: "greet"`. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) message?: string;
  /** `greet` asks Pip for an opening line in the shopper's language. */
  @IsOptional() @IsIn(['message', 'greet']) kind?: 'message' | 'greet';
  @IsOptional() @IsString() @MaxLength(64) sessionId?: string;
  /** Client-side state, at most 4 KB as JSON: { tryOn, locale, timeZone, lang, langMode, spoken, voiceOut, origin, results, events }. */
  @IsOptional() @IsObject() context?: Record<string, unknown>;
}

/** IPv4 as is; a public IPv6 address by its /64 (one phone or one home, where the device picks the rest at will). */
function network(ip: string) {
  // Some proxies (Azure Application Gateway, App Service) write "ip:port" into X-Forwarded-For: the port changes
  // with every connection, so it goes.
  ip = ip.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1');
  ip = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!/^[23][\da-f]{3}:/i.test(ip) || !isIPv6(ip)) return ip;
  const [head, tail] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  // Expand "::" to find the first four groups (an IPv4 tail such as 1.2.3.4 is two groups).
  const t = tail ? tail.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * A guest's network as an opaque id, so Pip's daily turns also hold for a script that drops its session id
 * (off-topic strikes stay on the guest's own chat: one carrier IP is often thousands of shoppers). Keyed with
 * the internal key, so the AI service gets an id, never the address. Without the key the AI service ignores
 * it anyway, so nothing is sent.
 */
const guestNetwork = (ip?: string) =>
  ip && env.internalApiKey ? createHmac('sha256', env.internalApiKey).update(network(ip)).digest('hex').slice(0, 32) : undefined;

export class SpeakDto {
  @IsString() @MinLength(1) @MaxLength(800) text: string;
  /** BCP-47 language of the text, e.g. "bn-BD". */
  @IsOptional() @Matches(LANG) lang?: string;
}

export class TranscribeDto {
  /** Only when the shopper picked a language; otherwise it's detected. */
  @IsOptional() @Matches(LANG) language?: string;
}

const AUDIO = /^(audio|video)\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|aac|x-m4a|m4a|opus|flac)/;

/** Gateway to the AI service, so the browser only ever talks to one authenticated API. */
@ApiTags('assistant')
@Controller('assistant')
export class AssistantController {
  /** Which AI features are switched on (multilingual brain, AI try-on, voice), so the app picks the best path. */
  @Get('capabilities')
  @Header('Cache-Control', 'public, max-age=30')
  capabilities() {
    return aiCapabilities();
  }

  @Post('chat')
  @UseGuards(OptionalAuthGuard)
  // Every message can be an LLM call; a person chatting stays well under this.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  chat(@CurrentUser() user: AuthUser | undefined, @Body() dto: ChatDto, @Ip() ip: string) {
    const kind = dto.kind ?? 'message';
    if (kind === 'message' && !dto.message?.trim()) throw new BadRequestException('Say something to Pip first.');
    if (dto.context && Buffer.byteLength(JSON.stringify(dto.context)) > CONTEXT_MAX) throw new BadRequestException('That chat context is too large.');
    // Signed-in shoppers are counted by account; guests by session and by network (TRUST_PROXY decides the IP).
    const client = user ? undefined : guestNetwork(ip);
    return callAi('/agent/chat', {
      method: 'POST',
      // An LLM reply can take several seconds.
      timeoutMs: 45_000,
      body: JSON.stringify({ message: dto.message, kind, session_id: dto.sessionId, user_id: user?.id, client, context: dto.context }),
    });
  }

  /** Speech in any language → { text, lang, confidence }. */
  @Post('transcribe')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  async transcribe(@UploadedFile() audio: Express.Multer.File | undefined, @Body() dto: TranscribeDto) {
    if (!audio?.size) throw new BadRequestException('Send a voice recording.');
    const type = audio.mimetype.split(';')[0];
    if (!AUDIO.test(type)) throw new BadRequestException('That recording format isn’t supported.');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio.buffer)], { type }), audio.originalname || 'speech.webm');
    if (dto.language) form.append('language', dto.language);
    return callAi('/speech/transcribe', { method: 'POST', body: form, timeoutMs: 30_000 });
  }

  /** Pip's voice as MP3, in the language of the text. */
  @Post('speak')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async speak(@Body() dto: SpeakDto) {
    const res = await callAiRaw('/speech/speak', { method: 'POST', body: JSON.stringify(dto), timeoutMs: 30_000 });
    return new StreamableFile(Buffer.from(await res.arrayBuffer()), { type: 'audio/mpeg', disposition: 'inline' });
  }

  /** LiveKit access token for real-time voice (503 until LiveKit keys are configured). */
  @Post('voice-token')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  voiceToken(@CurrentUser() user: AuthUser) {
    return callAi('/voice/token', { method: 'POST', body: JSON.stringify({ identity: user.id }) });
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async health() {
    const check = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await fn();
        return { ok: true, ms: Date.now() - t };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    };
    const [database, redis, ai] = await Promise.all([
      check(() => this.db.$queryRaw`SELECT 1`),
      check(() => this.redis.ping()),
      check(async () => {
        const r = await fetch(`${env.aiServiceUrl}/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) throw new Error(`status ${r.status}`);
      }),
    ]);
    // The AI service is optional: search falls back to keywords without it.
    return { status: database.ok && redis.ok ? 'ok' : 'degraded', database, redis, ai };
  }
}

@Module({ controllers: [AssistantController, HealthController] })
export class AssistantModule {}
