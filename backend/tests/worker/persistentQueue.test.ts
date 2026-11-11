import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { geminiService } from '../../src/services/gemini.service.js';
import { queueService } from '../../src/worker/queue.service.js';
import { jobProcessorService } from '../../src/worker/processor.service.js';
import {
  createPullRequestWebhookPayload,
  signPayload,
  TEST_WEBHOOK_SECRET,
  repoA,
  userA,
} from '../fixtures/index.js';

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
    },
    webhookDelivery: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    processingRun: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    processingStep: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    webhookLog: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../../src/services/github.service.js', () => ({
  githubService: {
    getPullRequestHeadSha: vi.fn(),
    getPullRequestDiff: vi.fn(),
    findPullRequestComment: vi.fn(),
    postPullRequestComment: vi.fn(),
  },
}));

vi.mock('../../src/services/gemini.service.js', () => ({
  geminiService: {
    analyzePullRequest: vi.fn(),
  },
}));

vi.mock('../../src/services/prProcessor.service.js', () => ({
  prProcessorService: {
    processPullRequest: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Persistent Event Queue, Worker Leases & Reconciliation (V11 to V16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Cases V11 & V12: Delivery Idempotency and Tampering Protection', () => {
    it('Case V11: admits delivery, creates run, and responds 202 on first arrival', async () => {
      const payload = createPullRequestWebhookPayload({});
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody, TEST_WEBHOOK_SECRET);

      vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        ...repoA,
        isActive: true,
        desiredActive: true,
        provisioningState: 'ACTIVE',
      });

      vi.mocked(prisma.processingRun.upsert).mockResolvedValueOnce({
        id: 'run-uuid-1',
        repositoryId: repoA.id,
        prNumber: payload.number,
        prTitle: payload.pull_request.title,
        headSha: payload.pull_request.head.sha,
        status: 'QUEUED',
      } as any);

      const res = await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', 'deliv-001')
        .set('x-hub-signature-256', signature)
        .send(rawBody);

      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({
        deliveryId: 'deliv-001',
        runId: 'run-uuid-1',
        status: 'QUEUED',
      });

      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deliveryId: 'deliv-001',
            admissionStatus: 'ADMITTED',
          }),
        })
      );
    });

    it('Case V11: idempotently acknowledges duplicate delivery with 200 without creating new run', async () => {
      const payload = createPullRequestWebhookPayload({});
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody, TEST_WEBHOOK_SECRET);

      // Same digest as what will be computed from rawBody
      const crypto = await import('node:crypto');
      const digest = crypto.createHash('sha256').update(Buffer.from(rawBody)).digest('hex');

      vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValueOnce({
        id: 'db-deliv-1',
        deliveryId: 'deliv-dup-001',
        payloadDigest: digest,
        admissionStatus: 'ADMITTED',
      } as any);

      const res = await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', 'deliv-dup-001')
        .set('x-hub-signature-256', signature)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        received: true,
        duplicate: true,
        deliveryId: 'deliv-dup-001',
      });

      // No new delivery or run created
      expect(prisma.processingRun.upsert).not.toHaveBeenCalled();
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });

    it('Case V12: rejects tampered delivery payload (known delivery ID with different digest) with 409', async () => {
      const payload = createPullRequestWebhookPayload({});
      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody, TEST_WEBHOOK_SECRET);

      vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValueOnce({
        id: 'db-deliv-1',
        deliveryId: 'deliv-tampered',
        payloadDigest: 'previously_recorded_different_hash_value',
        admissionStatus: 'ADMITTED',
      } as any);

      const res = await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', 'deliv-tampered')
        .set('x-hub-signature-256', signature)
        .send(rawBody);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        success: false,
        error: 'Tampered webhook delivery detected',
      });

      expect(prisma.processingRun.upsert).not.toHaveBeenCalled();
    });
  });

  describe('Case V14: Worker Lease Concurrency & Exclusivity', () => {
    it('guarantees exclusive lease to the winning worker when multiple workers compete', async () => {
      const candidateRun = {
        id: 'run-lease-1',
        status: 'QUEUED',
        availableAt: new Date(Date.now() - 1000),
        leaseUntil: null,
      };

      vi.mocked(prisma.processingRun.findFirst).mockResolvedValue(candidateRun as any);

      // Worker 1 succeeds in conditional update
      vi.mocked(prisma.processingRun.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.processingRun.findUnique).mockResolvedValueOnce({
        ...candidateRun,
        status: 'RUNNING',
        leaseOwner: 'worker-1',
      } as any);

      const runWorker1 = await queueService.reserveNextJob('worker-1');
      expect(runWorker1).not.toBeNull();
      expect(runWorker1?.id).toBe('run-lease-1');

      // Worker 2 attempts same candidate but updateMany returns count: 0 (lost lease race)
      vi.mocked(prisma.processingRun.updateMany).mockResolvedValueOnce({ count: 0 });

      const runWorker2 = await queueService.reserveNextJob('worker-2');
      expect(runWorker2).toBeNull();
    });
  });

  describe('Case V15: External Effect Reconciliation (Idempotent Comments)', () => {
    it('recovers existing comment on PR without posting another comment if already created', async () => {
      const run = {
        id: 'run-reconcile-1',
        prNumber: 42,
        headSha: 'sha-head-123',
        status: 'RUNNING',
        repository: {
          ...repoA,
          user: userA,
        },
      };

      vi.mocked(githubService.getPullRequestHeadSha).mockResolvedValueOnce({
        headSha: 'sha-head-123',
        state: 'open',
      });

      vi.mocked(githubService.getPullRequestDiff).mockResolvedValueOnce('diff --git a/a.ts b/a.ts');

      vi.mocked(geminiService.analyzePullRequest).mockResolvedValueOnce({
        kind: 'analyzed',
        data: {
          schemaVersion: 1,
          summary: 'Looks good.',
          categories: ['feat'],
          findings: [],
        },
        usage: null,
        truncated: false,
      });

      // Reconciliation: GitHub already has a comment with the review marker!
      vi.mocked(githubService.findPullRequestComment).mockResolvedValueOnce(
        'https://github.com/alice-developer/alice-project/pull/42#issuecomment-999'
      );

      vi.mocked(prisma.processingStep.upsert).mockResolvedValue({} as any);
      vi.mocked(prisma.processingStep.update).mockResolvedValue({} as any);
      vi.mocked(prisma.processingRun.update).mockResolvedValue({} as any);

      await jobProcessorService.processRun(run, 'worker-1');

      // CRITICAL (V15): Verified that postPullRequestComment was NEVER called
      expect(githubService.postPullRequestComment).not.toHaveBeenCalled();

      // Verified run concluded with existing comment url
      expect(prisma.processingRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-reconcile-1' },
          data: expect.objectContaining({
            status: 'SUCCESS',
            commentUrl: 'https://github.com/alice-developer/alice-project/pull/42#issuecomment-999',
          }),
        })
      );
    });
  });

  describe('Case V16: Head Advance / Superseded Detection', () => {
    it('marks run as SUPERSEDED and skips execution when PR head SHA on GitHub has advanced', async () => {
      const run = {
        id: 'run-stale-1',
        prNumber: 42,
        headSha: 'old-sha-1111',
        status: 'RUNNING',
        repository: {
          ...repoA,
          user: userA,
        },
      };

      // GitHub reports that new commits were pushed: head is now new-sha-2222
      vi.mocked(githubService.getPullRequestHeadSha).mockResolvedValueOnce({
        headSha: 'new-sha-2222',
        state: 'open',
      });

      vi.mocked(prisma.processingStep.upsert).mockResolvedValue({} as any);
      vi.mocked(prisma.processingRun.update).mockResolvedValue({} as any);

      await jobProcessorService.processRun(run, 'worker-1');

      // Assert that neither diff nor Gemini nor comments were invoked for stale head
      expect(githubService.getPullRequestDiff).not.toHaveBeenCalled();
      expect(geminiService.analyzePullRequest).not.toHaveBeenCalled();
      expect(githubService.postPullRequestComment).not.toHaveBeenCalled();

      // Assert run was updated to SUPERSEDED
      expect(prisma.processingRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-stale-1' },
          data: expect.objectContaining({
            status: 'SUPERSEDED',
            lastErrorCode: 'HEAD_SHA_SUPERSEDED',
          }),
        })
      );
    });
  });
});
