import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { cryptoService } from '../../src/services/crypto.service.js';
import { repoA, userA } from '../fixtures/index.js';

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    docProposal: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn(),
    user: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    repository: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    processingRun: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../src/services/github.service.js', () => ({
  githubService: {
    listUserRepositories: vi.fn(),
  },
}));

describe('Operations, Pagination, Real Aggregates & Readiness (ADR 0001, V23, V24)', () => {
  const validAssertion = cryptoService.signInternalAssertion({
    userId: userA.id,
    githubId: userA.githubId,
    username: userA.username,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...userA,
      tokenRevokedAt: null,
    } as any);
  });

  describe('Case V23: Pagination, Real Aggregates & Error Visibility', () => {
    it('returns paginated repositories with accurate totals, pagination metadata, and real aggregates', async () => {
      // 25 GitHub repositories
      const mockGhRepos = Array.from({ length: 25 }, (_, i) => ({
        id: 1000 + i,
        name: `repo-${i + 1}`,
        fullName: `alice-developer/repo-${i + 1}`,
        owner: 'alice-developer',
        private: false,
        htmlUrl: `https://github.com/alice-developer/repo-${i + 1}`,
        defaultBranch: 'main',
        description: null,
      }));

      // 5 tracked in DB (3 active, 1 error, 1 disabled)
      const mockDbRepos = [
        { ...repoA, githubRepoId: 1001, isActive: true, provisioningState: 'ACTIVE' },
        { ...repoA, githubRepoId: 1002, isActive: true, provisioningState: 'ACTIVE' },
        { ...repoA, githubRepoId: 1003, isActive: true, provisioningState: 'ACTIVE' },
        { ...repoA, githubRepoId: 1004, isActive: false, provisioningState: 'ERROR' },
        { ...repoA, githubRepoId: 1005, isActive: false, provisioningState: 'DISABLED' },
      ];

      vi.mocked(githubService.listUserRepositories).mockResolvedValueOnce(mockGhRepos);
      vi.mocked(prisma.repository.findMany).mockResolvedValueOnce(mockDbRepos as any);

      // Request page 2 with limit 10
      const res = await request(app)
        .get('/api/repositories?page=2&limit=10')
        .set('Authorization', `Bearer ${validAssertion}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
      });

      // Page 2 should contain 10 items (items 11 through 20)
      expect(data.items).toHaveLength(10);
      expect(data.items[0].name).toBe('repo-11');

      // Real aggregates calculation
      expect(data.aggregates).toMatchObject({
        totalRepositories: 25,
        activeRepositories: 3,
        errorRepositories: 1,
      });
    });

    it('returns paginated webhook logs with counts and filters', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          repositoryId: repoA.id,
          prNumber: 42,
          prTitle: 'PR 42',
          status: 'SUCCESS',
          rawDiffSize: 1200,
          errorMessage: null,
          responseCommentUrl: 'https://github.com/...',
          createdAt: new Date().toISOString(),
          repository: { name: 'alice-project', fullName: 'alice-developer/alice-project', owner: 'alice-developer' },
        },
      ];

      vi.mocked(prisma.processingRun.count).mockResolvedValueOnce(55);
      vi.mocked(prisma.processingRun.findMany).mockResolvedValueOnce(mockLogs as any);

      const res = await request(app)
        .get('/api/webhooks/logs?page=1&limit=20&status=SUCCESS')
        .set('Authorization', `Bearer ${validAssertion}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 55,
        totalPages: 3,
      });
      expect(res.body.data.items).toHaveLength(1);

      expect(prisma.processingRun.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'SUCCESS',
          }),
        })
      );
    });

    it('returns explicit HTTP 500 error on database failure when fetching logs without masking as empty list', async () => {
      vi.mocked(prisma.processingRun.count).mockRejectedValueOnce(new Error('Connection lost to PostgreSQL'));

      const res = await request(app)
        .get('/api/webhooks/logs')
        .set('Authorization', `Bearer ${validAssertion}`);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Failed to fetch webhook logs');
      // Must NOT return empty array
      expect(res.body.data).toBeNull();
    });
  });

  describe('Case V24: Health & Readiness Endpoints (ADR 0001, V24)', () => {
    it('returns 200 on /health and /health/liveness with service status', async () => {
      const resLive = await request(app).get('/health/liveness');
      expect(resLive.status).toBe(200);
      expect(resLive.body.data).toMatchObject({
        status: 'ok',
        service: 'gitdocs-backend',
      });

      const resHealth = await request(app).get('/health');
      expect(resHealth.status).toBe(200);
      expect(resHealth.body.data.status).toBe('ok');
    });

    it('returns 200 on /health/readiness when database connectivity is verified', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ '?column?': 1 }]);

      const res = await request(app).get('/health/readiness');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        status: 'ready',
        database: 'connected',
        service: 'gitdocs-backend',
      });
    });

    it('returns 503 Service Unavailable on /health/readiness when database is down', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('ECONNREFUSED: PostgreSQL unavailable'));

      const res = await request(app).get('/health/readiness');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        success: false,
        status: 'not_ready',
        database: 'disconnected',
        error: 'Database unavailable',
      });
    });
  });
});
