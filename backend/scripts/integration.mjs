import { spawnSync } from 'node:child_process';
const raw = process.env.TEST_DATABASE_URL || process.argv.find(arg => arg.startsWith('--database-url='))?.slice('--database-url='.length);
if (!raw) throw new Error('TEST_DATABASE_URL is required; only an isolated local *_test database is permitted');
const url = new URL(raw);
if (!['localhost', '127.0.0.1', 'postgres'].includes(url.hostname) || !url.pathname.endsWith('_test') || process.env.NODE_ENV === 'production') {
  throw new Error('Refusing integration tests against a non-local or non-test database');
}
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: raw };
for (const [bin, args] of [['prisma', ['migrate', 'deploy']], ['prisma', ['migrate', 'diff', '--from-url', raw, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']], ['vitest', ['run', '--config', 'vitest.integration.config.ts']]]) {
  const result = spawnSync(bin, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
