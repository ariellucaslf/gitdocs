import crypto from 'node:crypto';
import { Prisma, DocProposal } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { githubService } from './github.service.js';
import { docPatchService, PatchOperation } from './docPatch.service.js';
import { resolveUserAccessToken } from './crypto.service.js';
import { HttpError, externalStatus } from '../utils/errors.js';

export interface CreateProposalInput {
  runId?: string; repositoryId: string; prNumber: number; headSha: string; title: string;
  description?: string; targetPath?: string; operations: PatchOperation[]; evidence?: string;
  isFork?: boolean; originalFileContent: string | null;
}

export class DocProposalService {
  async createProposal(input: CreateProposalInput) {
    const targetPath = input.targetPath || 'README.md';
    const patch = docPatchService.applyPatch(input.originalFileContent, input.operations, targetPath);
    if (!patch.success) throw new HttpError(422, patch.code);
    const data = { repositoryId: input.repositoryId, runId: input.runId, prNumber: input.prNumber,
      headSha: input.headSha, baseFileHash: patch.baseFileHash, targetPath, title: input.title,
      description: input.description, operations: input.operations as unknown as Prisma.InputJsonValue,
      evidence: input.evidence, previewContent: patch.patchedContent, isFork: input.isFork ?? false };
    return input.runId
      ? prisma.docProposal.upsert({ where: { runId: input.runId }, update: {}, create: data })
      : prisma.docProposal.create({ data });
  }

  private async ownedProposal(id: string, userId: string) {
    const proposal = await prisma.docProposal.findUnique({ where: { id }, include: { repository: { include: { user: true } } } });
    if (!proposal || proposal.repository.userId !== userId) throw new HttpError(404, 'PROPOSAL_NOT_FOUND');
    return proposal;
  }

  async approveProposal(proposalId: string, userId: string): Promise<{ success: boolean; proposal: DocProposal; commitSha: string | null; commitUrl: string | null }> {
    const proposal = await this.ownedProposal(proposalId, userId);
    const repo = proposal.repository;
    if (!repo.isActive || !repo.desiredActive) throw new HttpError(409, 'MONITORING_DISABLED');
    if (proposal.isFork) throw new HttpError(403, 'FORK_WRITE_FORBIDDEN');
    const accessToken = resolveUserAccessToken(repo.user);
    const canonical = await githubService.getRepositoryById(accessToken, repo.githubRepoId);
    if (!canonical.permissions?.push && !canonical.permissions?.admin) throw new HttpError(403, 'WRITE_PERMISSION_REQUIRED');
    if (proposal.status === 'APPLIED') return { success: true, proposal, commitSha: proposal.commitSha, commitUrl: proposal.commitUrl };
    if (proposal.status === 'APPLYING') {
      const intent = await prisma.commitIntent.findFirst({ where: { proposalId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
      const pr = await githubService.getPullRequestDetails(accessToken, repo.owner, repo.name, proposal.prNumber);
      if (intent?.preparedCommitSha && pr && !pr.isFork) {
        const verified = await githubService.verifyDocCommit(accessToken, repo.owner, repo.name, intent.preparedCommitSha, intent);
        if (verified) {
          const published = await githubService.isCommitInHistory(accessToken, repo.owner, repo.name, intent.preparedCommitSha, pr.headSha);
          if (published) return this.confirm(proposal.id, intent.id, intent.preparedCommitSha, repo.fullName);
          if (pr.state === 'open' && pr.headSha === intent.expectedParentSha && pr.headRef !== pr.baseRef) {
            await githubService.publishPreparedCommit(accessToken, repo.owner, repo.name, pr.headRef, intent.preparedCommitSha);
            return this.confirm(proposal.id, intent.id, intent.preparedCommitSha, repo.fullName);
          }
          throw new HttpError(409, 'HEAD_ADVANCED');
        }
      }
      // A crash before persisting a commit intent is safe to retry after its request has expired.
      if (!intent?.preparedCommitSha && proposal.updatedAt.getTime() < Date.now() - 300000) {
        if (intent) await prisma.commitIntent.updateMany({ where: { id: intent.id, status: 'PENDING', preparedCommitSha: null }, data: { status: 'ABANDONED' } });
        const reset = await prisma.docProposal.updateMany({ where: { id: proposalId, status: 'APPLYING', updatedAt: proposal.updatedAt }, data: { status: 'PENDING_APPROVAL' } });
        if (reset.count) return this.approveProposal(proposalId, userId);
      }
      throw new HttpError(409, 'APPROVAL_REQUIRES_RECONCILIATION');
    }
    if (proposal.status !== 'PENDING_APPROVAL') throw new HttpError(409, 'CONCURRENT_APPROVAL_CONFLICT');
    const lock = await prisma.docProposal.updateMany({ where: { id: proposalId, status: 'PENDING_APPROVAL', repository: { userId } },
      data: { status: 'APPLYING', approvedByUserId: userId, approvedAt: new Date() } });
    if (!lock.count) throw new HttpError(409, 'CONCURRENT_APPROVAL_CONFLICT');
    let intentId: string | undefined;
    try {
      const pr = await githubService.getPullRequestDetails(accessToken, repo.owner, repo.name, proposal.prNumber);
      if (!pr || pr.state !== 'open') throw new HttpError(409, 'PR_CLOSED');
      if (pr.isFork) throw new HttpError(403, 'FORK_WRITE_FORBIDDEN');
      if (pr.headRef === pr.baseRef) throw new HttpError(403, 'BASE_BRANCH_WRITE_FORBIDDEN');
      if (pr.headSha !== proposal.headSha) throw new HttpError(409, 'HEAD_ADVANCED');
      const file = await githubService.getFileContent(accessToken, repo.owner, repo.name, proposal.targetPath, pr.headSha);
      const current = file?.content ?? null;
      const currentHash = crypto.createHash('sha256').update(current ?? '', 'utf8').digest('hex');
      if (currentHash !== proposal.baseFileHash) throw new HttpError(409, 'FILE_MODIFIED_CONCURRENTLY');
      const patch = docPatchService.applyPatch(current, proposal.operations as unknown as PatchOperation[], proposal.targetPath);
      if (!patch.success) throw new HttpError(422, patch.code);
      if (patch.patchedContent !== proposal.previewContent) throw new HttpError(409, 'PREVIEW_MISMATCH');
      const intent = await prisma.commitIntent.create({ data: { proposalId, repositoryId: repo.id, prNumber: proposal.prNumber,
        expectedParentSha: proposal.headSha, expectedContentHash: patch.newContentHash } });
      intentId = intent.id;
      const { commitSha } = await githubService.createDocCommit(accessToken, repo.owner, repo.name, pr.headRef, proposal.headSha,
        proposal.targetPath, patch.patchedContent, `docs: apply approved documentation proposal\n\nIntent-ID: ${intent.id}`,
        async sha => {
          const prepared = await prisma.commitIntent.updateMany({ where: { id: intent.id, status: 'PENDING', proposal: { status: 'APPLYING' } }, data: { preparedCommitSha: sha } });
          if (!prepared.count) throw new HttpError(409, 'COMMIT_INTENT_NO_LONGER_ACTIVE');
        });
      return await this.confirm(proposal.id, intent.id, commitSha, repo.fullName);
    } catch (error) {
      const status = externalStatus(error) ?? (error instanceof HttpError ? error.statusCode : undefined);
      const definitive = !!status && [400, 401, 403, 404, 409, 422].includes(status);
      // Timeout or database failure after a possible ref update is ambiguous: preserve the intent.
      if (!intentId || definitive) {
        if (intentId) await prisma.commitIntent.updateMany({ where: { id: intentId, status: 'PENDING' }, data: { status: 'ABANDONED' } });
        await prisma.docProposal.updateMany({ where: { id: proposalId, status: 'APPLYING' },
          data: { status: status === 409 || status === 422 ? 'STALE' : 'FAILED', failureReason: error instanceof HttpError ? error.code : 'DOCUMENTATION_APPLY_FAILED' } });
      }
      throw error instanceof HttpError ? error : new HttpError(definitive ? status! : 503, 'DOCUMENTATION_APPLY_REQUIRES_RECONCILIATION');
    }
  }

  private async confirm(proposalId: string, intentId: string, sha: string, fullName: string) {
    const commitUrl = `https://github.com/${fullName}/commit/${sha}`;
    const proposal = await prisma.$transaction(async tx => {
      await tx.commitIntent.update({ where: { id: intentId }, data: { status: 'CONFIRMED', appliedCommitSha: sha } });
      return tx.docProposal.update({ where: { id: proposalId }, data: { status: 'APPLIED', commitSha: sha, commitUrl, failureReason: null } });
    });
    return { success: true, proposal, commitSha: sha, commitUrl };
  }

  async rejectProposal(proposalId: string, userId: string, reason?: string) {
    await this.ownedProposal(proposalId, userId);
    const result = await prisma.docProposal.updateMany({ where: { id: proposalId, status: 'PENDING_APPROVAL', repository: { userId } },
      data: { status: 'REJECTED', failureReason: reason?.slice(0, 1000) || 'Rejected by user' } });
    if (!result.count) throw new HttpError(409, 'CONCURRENT_APPROVAL_CONFLICT');
    return prisma.docProposal.findUnique({ where: { id: proposalId } });
  }

  async getProposal(proposalId: string, userId: string) {
    const { repository: _repository, ...proposal } = await this.ownedProposal(proposalId, userId);
    return proposal; // Never serialize repository.user (including its credentials).
  }

  async listProposals(repositoryId: string, userId: string, prNumber?: number) {
    const repo = await prisma.repository.findFirst({ where: { id: repositoryId, userId } });
    if (!repo) throw new HttpError(404, 'REPOSITORY_NOT_FOUND');
    return prisma.docProposal.findMany({ where: { repositoryId, ...(prNumber ? { prNumber } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
export const docProposalService = new DocProposalService();
