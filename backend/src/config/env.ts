import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

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
    GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
    GEMINI_TIMEOUT_MS: z.coerce.number().default(60000),
    INTERNAL_AUTH_SECRET: z.string().default('gitdocs-internal-auth-secret-change-in-production'),
    ENCRYPTION_KEY: z.string().default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
    ENCRYPTION_KEY_VERSION: z.string().default('v1'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production' && data.GITHUB_WEBHOOK_URL) {
        return data.GITHUB_WEBHOOK_URL.startsWith('https://');
      }
      return true;
    },
    {
      message: 'GITHUB_WEBHOOK_URL must use HTTPS in production environments',
      path: ['GITHUB_WEBHOOK_URL'],
    }
  );

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
