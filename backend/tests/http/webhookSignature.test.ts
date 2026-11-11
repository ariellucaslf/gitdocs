import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import {
  createPullRequestWebhookPayload,
  signPayload,
  TEST_WEBHOOK_SECRET,
} from '../fixtures/index.js';
import { prisma } from '../../src/config/prisma.js';

// Mock prisma for HTTP unit tests so we don't hit a live database
vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
    },
    webhookLog: {
      create: vi.fn(),
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
    commitIntent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    docProposal: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock prProcessor to prevent background work during contract test
vi.mock('../../src/services/prProcessor.service.js', () => ({
  prProcessorService: {
    processPullRequest: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Webhook Signature Middleware (HMAC verification)', () => {
  const payload = createPullRequestWebhookPayload({});
  const rawBody = JSON.stringify(payload);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects request with 401 when signature header is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Missing GitHub Webhook signature header',
    });
  });

  it('rejects request with 401 when signature is invalid', async () => {
    const invalidSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    const res = await request(app)
      .post('/api/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', invalidSignature)
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Invalid webhook signature',
    });
  });

  it('rejects request with 401 when payload does not match signature (tampered payload)', async () => {
    const signatureForDifferentBody = signPayload({ different: 'data' }, TEST_WEBHOOK_SECRET);

    const res = await request(app)
      .post('/api/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signatureForDifferentBody)
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Invalid webhook signature',
    });
  });

  it('accepts request with valid signature and proceeds to webhook handler', async () => {
    const validSignature = signPayload(rawBody, TEST_WEBHOOK_SECRET);

    // Mock repo findUnique to simulate inactive repo
    vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
      id: 'repo-uuid-aaa-101',
      githubRepoId: payload.repository.id,
      name: payload.repository.name,
      fullName: payload.repository.full_name,
      owner: payload.repository.owner.login,
      isActive: false,
      autoCommitReadme: false,
      webhookId: 1234,
      userId: 'user-uuid-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', validSignature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        message: 'Repository is inactive, skipped processing',
      },
    });
  });
});
