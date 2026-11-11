import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { repositoryProvisioningService } from '../../src/services/repositoryProvisioning.service.js';
import { userA, userB, repoA } from '../fixtures/index.js';
vi.mock('../../src/middlewares/auth.middleware.js', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.user = req.headers.authorization === 'B' ? userB : userA; next(); } }));
vi.mock('../../src/config/prisma.js', () => ({ prisma: { repository: { findUnique: vi.fn() } } }));
vi.mock('../../src/services/github.service.js', () => ({ githubService: { getRepositoryById: vi.fn() } }));
vi.mock('../../src/services/repositoryProvisioning.service.js', () => ({ repositoryProvisioningService: { request: vi.fn() } }));
beforeEach(() => { vi.resetAllMocks(); });
describe('Repository HTTP authorization', () => {
  it('denies a different owner before calling GitHub or changing provisioning', async () => {
    vi.mocked(prisma.repository.findUnique).mockResolvedValue(repoA as any);
    const res = await request(app).post('/api/repositories/toggle').set('Authorization', 'B').send({ githubRepoId: repoA.githubRepoId, isActive: false });
    expect(res.status).toBe(404); expect(githubService.getRepositoryById).not.toHaveBeenCalled(); expect(repositoryProvisioningService.request).not.toHaveBeenCalled();
  });
  it('requires confirmed admin permission even for the linked owner', async () => {
    vi.mocked(prisma.repository.findUnique).mockResolvedValue(repoA as any);
    vi.mocked(githubService.getRepositoryById).mockResolvedValue({ id: repoA.githubRepoId, name: 'project', owner: 'owner', fullName: 'owner/project', permissions: { push: true } });
    const res = await request(app).post('/api/repositories/toggle').send({ githubRepoId: repoA.githubRepoId, isActive: true });
    expect(res.status).toBe(403); expect(repositoryProvisioningService.request).not.toHaveBeenCalled();
  });
  it('passes canonical metadata and ignores forged client names', async () => {
    vi.mocked(prisma.repository.findUnique).mockResolvedValue(repoA as any);
    vi.mocked(githubService.getRepositoryById).mockResolvedValue({ id: repoA.githubRepoId, name: 'real', owner: 'owner', fullName: 'owner/real', permissions: { admin: true } });
    vi.mocked(repositoryProvisioningService.request).mockResolvedValue(repoA as any);
    const res = await request(app).post('/api/repositories/toggle').send({ githubRepoId: repoA.githubRepoId, isActive: true, owner: 'attacker', name: 'forged' });
    expect(res.status).toBe(200); expect(repositoryProvisioningService.request).toHaveBeenCalledWith(userA.id, repoA.githubRepoId, true, { name: 'real', owner: 'owner', fullName: 'owner/real' });
  });
});
