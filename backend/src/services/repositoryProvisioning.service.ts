import { prisma } from '../config/prisma.js';
import { githubService } from './github.service.js';
import { resolveUserAccessToken } from './crypto.service.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/errors.js';

export class RepositoryProvisioningService {
  async request(userId: string, repoId: number, active: boolean, canonical: { name: string; fullName: string; owner: string }) {
    let row;
    try {
      row = await prisma.$transaction(async tx => {
        const existing = await tx.repository.findUnique({ where: { githubRepoId: repoId } });
        if (existing && existing.userId !== userId) throw new HttpError(404, 'Repository not found');
        if (!existing && !active) throw new HttpError(404, 'Repository not found');
        if (!existing) return tx.repository.create({ data: { githubRepoId: repoId, userId, ...canonical,
          desiredActive: active, isActive: false, provisioningState: 'PROVISIONING' } });
        // Never upsert an update that could transfer/mutate a concurrent creator's record.
        const result = await tx.repository.updateMany({ where: { id: existing.id, userId },
          data: { ...canonical, desiredActive: active, isActive: false, provisioningState: 'PROVISIONING', lastErrorCode: null } });
        if (!result.count) throw new HttpError(409, 'REPOSITORY_CONFIGURATION_CONFLICT');
        return tx.repository.findUniqueOrThrow({ where: { id: existing.id } });
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') throw new HttpError(409, 'REPOSITORY_CONFIGURATION_CONFLICT');
      throw error;
    }
    return this.reconcile(row.id);
  }

  async reconcile(id: string) {
    const now = new Date();
    const lease = await prisma.repository.updateMany({
      where: { id, OR: [{ provisioningLeaseUntil: null }, { provisioningLeaseUntil: { lt: now } }] },
      data: { provisioningLeaseUntil: new Date(Date.now() + 120000), provisioningVersion: { increment: 1 } },
    });
    if (!lease.count) return prisma.repository.findUniqueOrThrow({ where: { id } });
    const repo = await prisma.repository.findUniqueOrThrow({ where: { id }, include: { user: true } });
    const fence = { id, provisioningVersion: repo.provisioningVersion, desiredActive: repo.desiredActive };
    try {
      if (!env.GITHUB_WEBHOOK_URL || !env.GITHUB_WEBHOOK_SECRET) throw new Error('WEBHOOK_CONFIGURATION_MISSING');
      const token = resolveUserAccessToken(repo.user);
      // Canonical permissions must still hold when recovering an interrupted operation.
      const canonical = await githubService.getRepositoryById(token, repo.githubRepoId);
      if (!canonical.permissions?.admin) throw new Error('ADMIN_PERMISSION_REQUIRED');
      if (repo.desiredActive) {
        const webhookId = await githubService.createRepositoryWebhook(token, canonical.owner, canonical.name, env.GITHUB_WEBHOOK_URL);
        await prisma.repository.updateMany({ where: fence, data: { name: canonical.name, owner: canonical.owner, fullName: canonical.fullName, isActive: true, provisioningState: 'ACTIVE', webhookId, lastErrorCode: null } });
      } else {
        const hookId = repo.webhookId ?? await githubService.findRepositoryWebhook(token, canonical.owner, canonical.name, env.GITHUB_WEBHOOK_URL);
        if (hookId) await githubService.deleteRepositoryWebhook(token, canonical.owner, canonical.name, hookId);
        await prisma.repository.updateMany({ where: fence, data: { isActive: false, provisioningState: 'DISABLED', webhookId: null, lastErrorCode: null } });
      }
    } catch {
      await prisma.repository.updateMany({ where: fence, data: { isActive: false, provisioningState: 'ERROR', lastErrorCode: 'WEBHOOK_RECONCILIATION_FAILED' } });
    } finally {
      await prisma.repository.updateMany({ where: { id, provisioningVersion: repo.provisioningVersion }, data: { provisioningLeaseUntil: null } });
    }
    const { user: _user, ...updated } = await prisma.repository.findUniqueOrThrow({ where: { id }, include: { user: true } });
    return updated;
  }

  async reconcileNext() {
    const repo = await prisma.repository.findFirst({ where: { provisioningState: 'PROVISIONING',
      OR: [{ provisioningLeaseUntil: null }, { provisioningLeaseUntil: { lt: new Date() } }] }, orderBy: { updatedAt: 'asc' } });
    if (repo) await this.reconcile(repo.id);
  }
}
export const repositoryProvisioningService = new RepositoryProvisioningService();
