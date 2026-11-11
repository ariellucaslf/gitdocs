process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ||
  'postgresql://gitdocs_user:gitdocs_password@localhost:5432/gitdocs_test?schema=public';
process.env['GITHUB_WEBHOOK_SECRET'] =
  process.env['GITHUB_WEBHOOK_SECRET'] || 'test-webhook-secret';
process.env['GEMINI_API_KEY'] =
  process.env['GEMINI_API_KEY'] || 'test-gemini-key';
