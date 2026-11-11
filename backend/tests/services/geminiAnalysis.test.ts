import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geminiService } from '../../src/services/gemini.service.js';
import { formatReviewComment } from '../../src/utils/commentFormatter.js';
import { prProcessorService } from '../../src/services/prProcessor.service.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { repoA, userA, createPullRequestWebhookPayload } from '../fixtures/index.js';
import { ValidatedAnalysis } from '../../src/types/analysis.js';

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
    },
    webhookLog: {
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/services/github.service.js', () => ({
  githubService: {
    getPullRequestDiff: vi.fn(),
    postPullRequestComment: vi.fn(),
    commitFileToBranch: vi.fn(),
  },
}));

describe('AI Analysis Contract, Schema Validation & Failure Handling (V09, V10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case V10: Diff Sanitization, Secret Redaction & Empty Diff Abstraction', () => {
    it('returns skipped with EMPTY_DIFF without invoking Gemini when diff is empty', async () => {
      const result = await geminiService.analyzePullRequest('Add feature', 'PR body', '');
      expect(result).toEqual({
        kind: 'skipped',
        reason: 'EMPTY_DIFF',
      });
    });

    it('strips lockfiles, env files, and secrets, returning skipped if no code remains', async () => {
      const diffWithOnlyIgnored = `diff --git a/package-lock.json b/package-lock.json
index 12345..67890 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-"version": "1.0.0"
+"version": "1.0.1"
diff --git a/.env b/.env
index 000..111 100644
--- a/.env
+++ b/.env
@@ -0,0 +1 @@
+SECRET_KEY=supersecret123
diff --git a/certs/server.pem b/certs/server.pem
index 000..111 100644
--- a/certs/server.pem
+++ b/certs/server.pem
+-----BEGIN RSA PRIVATE KEY-----`;

      const result = await geminiService.analyzePullRequest('Update locks and secrets', null, diffWithOnlyIgnored);
      expect(result).toEqual({
        kind: 'skipped',
        reason: 'EMPTY_DIFF',
      });
    });

    it('redacts sensitive files from mixed diffs preserving legitimate code changes', () => {
      const mixedDiff = `diff --git a/.env b/.env
+API_KEY=exposed_secret
diff --git a/src/index.ts b/src/index.ts
+console.log("Hello world");`;

      const { cleanDiff } = geminiService.sanitizeDiff(mixedDiff);
      expect(cleanDiff).not.toContain('.env');
      expect(cleanDiff).not.toContain('API_KEY=exposed_secret');
      expect(cleanDiff).toContain('src/index.ts');
      expect(cleanDiff).toContain('console.log("Hello world");');
    });

    it('truncates diffs exceeding maximum character limit and marks truncated flag', () => {
      const hugeDiff = `diff --git a/src/big.ts b/src/big.ts\n+` + 'a'.repeat(40000);
      const { cleanDiff, truncated } = geminiService.sanitizeDiff(hugeDiff);

      expect(truncated).toBe(true);
      expect(cleanDiff.length).toBeLessThanOrEqual(35000);
    });
  });

  describe('Case V09: Explicit Failure Handling & Error Classification', () => {
    it('classifies rate limit errors (429) as retryable RATE_LIMIT', () => {
      const error = new Error('Resource has been exhausted (e.g. check quota): 429');
      const classified = geminiService.classifyError(error);

      expect(classified).toMatchObject({
        code: 'RATE_LIMIT',
        retryable: true,
      });
    });

    it('classifies timeout / deadline exceeded errors as retryable TIMEOUT', () => {
      const error = new Error('Deadline exceeded: Request timed out');
      const classified = geminiService.classifyError(error);

      expect(classified).toMatchObject({
        code: 'TIMEOUT',
        retryable: true,
      });
    });

    it('classifies invalid API key errors as non-retryable AUTHENTICATION', () => {
      const error = new Error('API key not valid. Please pass a valid API key (401)');
      const classified = geminiService.classifyError(error);

      expect(classified).toMatchObject({
        code: 'AUTHENTICATION',
        retryable: false,
      });
    });

    it('handles AI failure in prProcessor by marking WebhookLog as ERROR and never posting a success comment', async () => {
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        ...repoA,
        user: userA,
      } as any);

      vi.mocked(githubService.getPullRequestDiff).mockResolvedValueOnce('diff --git a/src/app.ts b/src/app.ts\n+const x = 1;');
      vi.mocked(prisma.webhookLog.update).mockResolvedValue({} as any);

      // Simulate geminiService returning failure
      vi.spyOn(geminiService, 'analyzePullRequest').mockResolvedValueOnce({
        kind: 'failed',
        code: 'RATE_LIMIT',
        message: 'Google Gemini quota exceeded (429)',
        retryable: true,
      });

      const prPayload = createPullRequestWebhookPayload({});

      await prProcessorService.processPullRequest(
        'log-uuid-failure-test',
        repoA.id,
        prPayload.pull_request as any,
        prPayload.repository as any
      );

      // Verify comment was NEVER published to GitHub
      expect(githubService.postPullRequestComment).not.toHaveBeenCalled();

      // Verify WebhookLog status is ERROR with explicit code
      expect(prisma.webhookLog.update).toHaveBeenCalledWith({
        where: { id: 'log-uuid-failure-test' },
        data: {
          status: 'ERROR',
          errorMessage: 'AI_RATE_LIMIT: Google Gemini quota exceeded (429)',
        },
      });
    });

    it('handles skipped PR in prProcessor by recording skip reason without calling comment', async () => {
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        ...repoA,
        user: userA,
      } as any);

      vi.mocked(githubService.getPullRequestDiff).mockResolvedValueOnce('');
      vi.mocked(prisma.webhookLog.update).mockResolvedValue({} as any);

      const prPayload = createPullRequestWebhookPayload({});

      await prProcessorService.processPullRequest(
        'log-uuid-skip-test',
        repoA.id,
        prPayload.pull_request as any,
        prPayload.repository as any
      );

      expect(githubService.postPullRequestComment).not.toHaveBeenCalled();
      expect(prisma.webhookLog.update).toHaveBeenCalledWith({
        where: { id: 'log-uuid-skip-test' },
        data: {
          status: 'SUCCESS',
          errorMessage: 'Skipped: EMPTY_DIFF',
        },
      });
    });
  });

  describe('Comment Formatter: Deterministic Markdown Output', () => {
    it('formats a clean Markdown comment with findings and proposed doc changes', () => {
      const analysis: ValidatedAnalysis = {
        schemaVersion: 1,
        summary: 'This PR adds rate limiting and fixes auth token expiration.',
        categories: ['feat', 'security'],
        findings: [
          {
            file: 'src/middlewares/auth.ts',
            lineRange: '20-35',
            category: 'security',
            severity: 'critical',
            title: 'Missing token expiration check',
            message: 'Token does not check exp claim.',
            evidence: 'if (!token) return false;',
          },
        ],
        suggestedDocUpdate: {
          title: 'Document Rate Limiting',
          targetFile: 'README.md',
          description: 'Added RATE_LIMIT env var.',
          proposedContent: '### Rate Limiting\nConfigured via `RATE_LIMIT`.',
          evidence: 'env.ts addition',
        },
      };

      const formatted = formatReviewComment({
        analysis,
        usage: { model: 'gemini-2.5-flash', inputTokens: 500, outputTokens: 200 },
        truncated: false,
      });

      expect(formatted).toContain('## 🤖 GitDocs AI Review <!-- gitdocs-review -->');
      expect(formatted).toContain('`🔒 Security`');
      expect(formatted).toContain('`✨ Feature`');
      expect(formatted).toContain('Missing token expiration check');
      expect(formatted).toContain('Document Rate Limiting');
      expect(formatted).toContain('Model: `gemini-2.5-flash` • Tokens: 500 prompt / 200 response');
    });
  });
});
