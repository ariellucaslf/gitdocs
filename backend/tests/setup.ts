process.env['NODE_ENV'] = 'test';
process.env['INTERNAL_AUTH_SECRET'] ||= 'test-internal-secret-at-least-32-characters';
process.env['ENCRYPTION_KEY'] ||= 'b4'.repeat(32);
process.env['GEMINI_MODEL'] ||= 'test-model';
process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ||
  'postgresql://gitdocs_user:gitdocs_password@localhost:5432/gitdocs_test?schema=public';
process.env['GITHUB_WEBHOOK_SECRET'] = 'test-webhook-secret';
process.env['GITHUB_WEBHOOK_URL'] =
  process.env['GITHUB_WEBHOOK_URL'] || 'https://webhook.example.com/api/webhooks';
process.env['GEMINI_API_KEY'] =
  process.env['GEMINI_API_KEY'] || 'test-gemini-key';
