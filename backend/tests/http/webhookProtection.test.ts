import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import {
  createPullRequestWebhookPayload,
  signPayload,
  TEST_WEBHOOK_SECRET,
  repoA,
  userA,
} from '../fixtures/index.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { geminiService } from '../../src/services/gemini.service.js';
import { prProcessorService } from '../../src/services/prProcessor.service.js';

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
    },
    webhookLog: {
      create: vi.fn(),
      update: vi.fn(),
    },
    webhookDelivery: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    processingRun: {
      upsert: vi.fn().mockResolvedValue({ id: 'run-1', status: 'QUEUED' }),
    },
    processingStep: {
      create: vi.fn().mockResolvedValue({}),
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

vi.mock('../../src/services/gemini.service.js', () => ({
  geminiService: {
    analyzePullRequest: vi.fn(),
  },
}));

describe('Webhook Protection & Content Loss Mitigation (V04, V05, V08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case V05: Malformed JSON, Schema Validation & Payload Limits', () => {
    it('returns 400 when body contains malformed JSON syntax', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-hub-signature-256', 'sha256=1234')
        .send('{"invalid_json": true,'); // unclosed JSON

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: 'Malformed JSON payload',
      });
    });

    it('returns 400 when webhook payload structure is invalid (missing repository or pull_request)', async () => {
      const payload = { action: 'opened' };
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody, TEST_WEBHOOK_SECRET);

      const res = await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-hub-signature-256', signature)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: 'Invalid webhook payload structure',
      });
    });

    it('returns 413 when payload exceeds maximum size limit (5MB)', async () => {
      // 5.5 MB payload
      const hugeData = 'x'.repeat(5.5 * 1024 * 1024);
      const res = await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .send(`{"huge": "${hugeData}"}`);

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        success: false,
        error: 'Payload too large',
      });
    });
  });

  describe('Case V08: Content Loss Containment (Blocking legacy autocommit)', () => {
    it('never calls commitFileToBranch even when repo has autoCommitReadme=true and AI suggests README update', async () => {
      // Repository with legacy autoCommitReadme=true
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        ...repoA,
        autoCommitReadme: true,
        user: userA,
      } as any);

      vi.mocked(githubService.getPullRequestDiff).mockResolvedValueOnce('diff --git a/src/app.ts b/src/app.ts');
      vi.mocked(prisma.webhookLog.update).mockResolvedValue({} as any);

      // AI returns structured analysis with suggested doc update
      vi.mocked(geminiService.analyzePullRequest).mockResolvedValueOnce({
        kind: 'analyzed',
        data: {
          schemaVersion: 1,
          summary: 'Looks good.',
          categories: ['feat'],
          findings: [],
          suggestedDocUpdate: {
            title: 'Update README',
            targetFile: 'README.md',
            description: 'Docs changes',
            proposedContent: '# Overwritten README content by AI',
            evidence: 'diff evidence',
          },
        },
        usage: { model: 'test-model', inputTokens: 100, outputTokens: 50 },
        truncated: false,
      });

      vi.mocked(githubService.postPullRequestComment).mockResolvedValueOnce(
        'https://github.com/alice-developer/alice-project/pull/42#issuecomment-1'
      );

      const prPayload = createPullRequestWebhookPayload({});

      await prProcessorService.processPullRequest(
        'log-uuid-1',
        repoA.id,
        prPayload.pull_request as any,
        prPayload.repository as any
      );

      // Verify AI review comment was posted
      expect(githubService.postPullRequestComment).toHaveBeenCalledTimes(1);

      // CRITICAL (V08): Verify commitFileToBranch was NEVER called
      expect(githubService.commitFileToBranch).not.toHaveBeenCalled();

      // Verify log ended in SUCCESS without committing
      expect(prisma.webhookLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'log-uuid-1' },
          data: expect.objectContaining({
            status: 'SUCCESS',
            responseCommentUrl: 'https://github.com/alice-developer/alice-project/pull/42#issuecomment-1',
          }),
        })
      );
    });
  });
});
