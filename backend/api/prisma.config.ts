import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The .env file lives one level up and is shared with the AI service.
config({ path: '../.env', quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
