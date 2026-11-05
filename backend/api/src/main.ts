import { mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { env } from './config.js';
import { AppModule } from './app.module.js';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api/v1');
  if (env.trustProxy !== undefined) app.set('trust proxy', env.trustProxy);
  // Security headers. Product photos are drawn on canvases by the storefront (another origin in
  // production), so cross-origin resource loads stay allowed; the Swagger UI (dev only) needs inline scripts.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: env.production ? undefined : false }));
  // Product photos uploaded in the admin panel (re-encoded on upload, so only JPEG/PNG land here).
  mkdirSync(env.uploadDir, { recursive: true });
  app.useStaticAssets(env.uploadDir, {
    prefix: '/api/v1/uploads/',
    index: false,
    dotfiles: 'deny',
    maxAge: '30d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Public product photos: the storefront draws them on a canvas (quick preview, saved looks).
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  });
  app.enableCors({ origin: env.corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  // The API reference is for developers and the demo; a production API doesn't describe itself to the internet.
  if (!env.production) {
    const docs = new DocumentBuilder()
      .setTitle('Cartly Commerce API')
      .setDescription('Products, cart, checkout, orders, accounts and the gateway to Pip, the AI shopping assistant.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, docs));
  }
  return app;
}

/** Does anything answer on this port? */
const answers = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

if (process.env.NODE_ENV !== 'test') {
  // macOS lets a second server bind the same port on the other address family (IPv4 vs IPv6), so
  // listen() would succeed and `localhost` would reach whichever one answers first. Refuse instead.
  const busy = (await answers('127.0.0.1', env.port)) || (await answers('::1', env.port));
  if (busy) {
    console.error(
      `Port ${env.port} is already in use. See what holds it: lsof -nP -iTCP:${env.port} -sTCP:LISTEN\n` +
        'Stop that process, or set API_PORT in backend/.env.',
    );
    process.exit(1);
  }
  const app = await createApp();
  await app.listen(env.port);
  console.log(`Cartly API on http://localhost:${env.port}/api/v1 · docs at http://localhost:${env.port}/docs`);
}
