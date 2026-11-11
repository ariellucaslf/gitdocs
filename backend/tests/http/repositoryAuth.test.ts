import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { userA, userB, repoA } from '../fixtures/index.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';

const mockAuthHandler = (req: any, _res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${userA.accessToken}`) {
    req.user = userA;
    return next();
  }
  if (authHeader === `Bearer ${userB.accessToken}`) {
    req.user = userB;
    return next();
  }
  return _res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
};

// Mock auth middleware so we can simulate requests as userA or userB
vi.mock('../../src/middlewares/auth.middleware.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => mockAuthHandler(req, res, next),
}));

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/services/github.service.js', () => ({
  githubService: {
    listUserRepositories: vi.fn(),
    getRepositoryById: vi.fn(),
    createRepositoryWebhook: vi.fn(),
    deleteRepositoryWebhook: vi.fn(),
  },
}));

describe('Repository Authorization & Provisioning Security (V01, V02, V06, V07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case V01: Tenant Isolation', () => {
    it('returns 404 when User B attempts to toggle repository owned by User A without leaking state', async () => {
      // Mock existing repository owned by User A
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        ...repoA,
      });

      const res = await request(app)
        .post('/api/repositories/toggle')
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .send({
          githubRepoId: repoA.githubRepoId,
          isActive: false,
        });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: 'Repository not found',
      });

      // Assert no mutations took place
      expect(prisma.repository.update).not.toHaveBeenCalled();
      expect(prisma.repository.upsert).not.toHaveBeenCalled();
      expect(githubService.deleteRepositoryWebhook).not.toHaveBeenCalled();
      expect(githubService.createRepositoryWebhook).not.toHaveBeenCalled();
    });
  });

  describe('Case V02: Administrative Permissions & Canonical Metadata', () => {
    it('rejects with 403 when user lacks administrative permissions on the repository', async () => {
      // Repository not registered in DB yet
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce(null);

      // GitHub returns repository with admin: false
      vi.mocked(githubService.getRepositoryById).mockResolvedValueOnce({
        id: 999111,
        name: 'collab-project',
        fullName: 'org/collab-project',
        owner: 'org',
        permissions: { admin: false, push: true, pull: true },
      });

      const res = await request(app)
        .post('/api/repositories/toggle')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({
          githubRepoId: 999111,
          isActive: true,
        });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        error: 'Administrative permissions required on the GitHub repository to manage webhooks',
      });

      expect(githubService.createRepositoryWebhook).not.toHaveBeenCalled();
      expect(prisma.repository.upsert).not.toHaveBeenCalled();
    });

    it('resolves canonical metadata from GitHub ignoring forged client names', async () => {
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce(null);

      vi.mocked(githubService.getRepositoryById).mockResolvedValueOnce({
        id: 999222,
        name: 'real-repo',
        fullName: 'real-owner/real-repo',
        owner: 'real-owner',
        permissions: { admin: true },
      });

      vi.mocked(prisma.repository.upsert).mockResolvedValueOnce({
        id: 'new-repo-uuid',
        githubRepoId: 999222,
        name: 'real-repo',
        fullName: 'real-owner/real-repo',
        owner: 'real-owner',
        desiredActive: true,
        isActive: false,
        provisioningState: 'PROVISIONING',
        lastErrorCode: null,
        autoCommitReadme: false,
        webhookId: null,
        userId: userA.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      vi.mocked(githubService.createRepositoryWebhook).mockResolvedValueOnce(777001);

      vi.mocked(prisma.repository.update).mockResolvedValueOnce({
        id: 'new-repo-uuid',
        githubRepoId: 999222,
        name: 'real-repo',
        fullName: 'real-owner/real-repo',
        owner: 'real-owner',
        desiredActive: true,
        isActive: true,
        provisioningState: 'ACTIVE',
        lastErrorCode: null,
        autoCommitReadme: false,
        webhookId: 777001,
        userId: userA.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app)
        .post('/api/repositories/toggle')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({
          githubRepoId: 999222,
          name: 'forged-repo-name',
          fullName: 'attacker/forged-repo-name',
          owner: 'attacker',
          isActive: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify canonical data was used in upsert
      expect(prisma.repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            name: 'real-repo',
            fullName: 'real-owner/real-repo',
            owner: 'real-owner',
          }),
        })
      );
    });
  });

  describe('Case V06: Webhook Provisioning Failure Handling', () => {
    it('sets state to ERROR, keeps isActive false, and preserves intent when webhook creation fails', async () => {
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce(null);

      vi.mocked(githubService.getRepositoryById).mockResolvedValueOnce({
        id: repoA.githubRepoId,
        name: repoA.name,
        fullName: repoA.fullName,
        owner: repoA.owner,
        permissions: { admin: true },
      });

      vi.mocked(prisma.repository.upsert).mockResolvedValueOnce({
        ...repoA,
        desiredActive: true,
        isActive: false,
        provisioningState: 'PROVISIONING',
      });

      // GitHub webhook creation fails (e.g. timeout / network error)
      vi.mocked(githubService.createRepositoryWebhook).mockRejectedValueOnce(
        new Error('GitHub API timeout (504)')
      );

      vi.mocked(prisma.repository.update).mockResolvedValueOnce({
        ...repoA,
        desiredActive: true,
        isActive: false,
        provisioningState: 'ERROR',
        lastErrorCode: 'GitHub API timeout (504)',
      });

      const res = await request(app)
        .post('/api/repositories/toggle')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({
          githubRepoId: repoA.githubRepoId,
          isActive: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        isActive: false,
        desiredActive: true,
        provisioningState: 'ERROR',
        lastErrorCode: 'GitHub API timeout (504)',
      });
    });
  });

  describe('Case V07: Webhook Deletion Failure Handling', () => {
    it('pauses local processing immediately and marks ERROR while retaining webhookId when deletion fails', async () => {
      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        ...repoA,
        isActive: true,
        desiredActive: true,
        provisioningState: 'ACTIVE',
        webhookId: 555001,
      });

      vi.mocked(githubService.getRepositoryById).mockResolvedValueOnce({
        id: repoA.githubRepoId,
        name: repoA.name,
        fullName: repoA.fullName,
        owner: repoA.owner,
        permissions: { admin: true },
      });

      // Pause immediately call
      vi.mocked(prisma.repository.update).mockResolvedValueOnce({
        ...repoA,
        desiredActive: false,
        isActive: false,
      });

      // GitHub deletion fails
      vi.mocked(githubService.deleteRepositoryWebhook).mockRejectedValueOnce(
        new Error('Connection reset')
      );

      // Final update retains webhookId and flags ERROR
      vi.mocked(prisma.repository.update).mockResolvedValueOnce({
        ...repoA,
        desiredActive: false,
        isActive: false,
        provisioningState: 'ERROR',
        webhookId: 555001,
        lastErrorCode: 'WEBHOOK_DELETION_FAILED',
      });

      const res = await request(app)
        .post('/api/repositories/toggle')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({
          githubRepoId: repoA.githubRepoId,
          isActive: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        isActive: false,
        desiredActive: false,
        provisioningState: 'ERROR',
        webhookId: 555001,
        lastErrorCode: 'WEBHOOK_DELETION_FAILED',
      });
    });
  });
});
