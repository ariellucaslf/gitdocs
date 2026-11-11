import dotenv from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const envSchema = z
  .object({
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    GITHUB_CLIENT_ID: z.string().default(''),
    GITHUB_CLIENT_SECRET: z.string().default(''),
    GITHUB_WEBHOOK_SECRET: z.string().default(''),
    GITHUB_WEBHOOK_URL: z.string().default(''),
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    GEMINI_API_KEY: z.string().default(''),
    GEMINI_MODEL: z.string().default(''),
    GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().max(90000).default(60000),
    INTERNAL_AUTH_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'Expected a random 32-byte hex key'),
    ENCRYPTION_KEY_PREVIOUS: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    ENCRYPTION_KEY_VERSION: z.string().default('v1'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .refine(
    (data) => {
      if (!data.GITHUB_WEBHOOK_URL) return true;
      try {
        const url = new URL(data.GITHUB_WEBHOOK_URL);
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !!data.GITHUB_WEBHOOK_SECRET;
      } catch { return false; }
    },
    {
      message: 'Webhook URL must be HTTPS without credentials/fragment and requires a webhook secret',
      path: ['GITHUB_WEBHOOK_URL'],
    }
  );

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
