import { describe, expect, it, vi } from 'vitest';
import { GeminiService } from '../../src/services/gemini.service.js';
const diff = 'diff --git a/src/mapping.ts b/src/mapping.ts\n+const enabled = true;';
const valid = { summary: 'Adds a flag', categories: ['feat'], findings: [], suggestedDocUpdate: null };
function service(response: object) {
  const generateContent = vi.fn().mockResolvedValue(response);
  return { adapter: new GeminiService({ models: { generateContent } } as any), generateContent };
}
describe('Gemini transport and untrusted output', () => {
  it('uses the maintained client with a timeout, abort signal, JSON mode and output budget', async () => {
    const { adapter, generateContent } = service({ text: JSON.stringify(valid) });
    expect((await adapter.analyzePullRequest('Title', null, diff)).kind).toBe('analyzed');
    const config = generateContent.mock.calls[0]![0].config;
    expect(config.httpOptions.timeout).toBe(60000); expect(config.abortSignal).toBeInstanceOf(AbortSignal); expect(config.maxOutputTokens).toBe(8000);
  });
  it.each(['not json', JSON.stringify({ ...valid, suggestedDocUpdate: { targetFile: '../file', proposedContent: 'replace everything' } })])('rejects malformed or unsafe output', async text => {
    const { adapter } = service({ text });
    expect(await adapter.analyzePullRequest('Title', null, diff)).toMatchObject({ kind: 'failed', code: 'INVALID_OUTPUT' });
  });
  it('keeps mapping.ts and strips credentials even when renamed to an innocuous destination', () => {
    const adapter = new GeminiService();
    const result = adapter.sanitizeDiff(diff + '\ndiff --git a/.env b/config.txt\n+TOKEN=private');
    expect(result.cleanDiff).toContain('src/mapping.ts'); expect(result.cleanDiff).not.toContain('private');
  });
  it('redacts known credentials in ordinary source files', () => {
    expect(new GeminiService().sanitizeDiff(diff + '\n+const token = "ghp_abcdefghijklmnopqrstuv";').cleanDiff).not.toContain('ghp_');
  });
  it('treats an unavailable model as configuration rather than retrying indefinitely', () => {
    expect(new GeminiService().classifyError({ status: 404 })).toMatchObject({ code: 'CONFIGURATION', retryable: false });
  });
});
