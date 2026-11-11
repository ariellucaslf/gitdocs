import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { docProposalService } from '../../src/services/docProposal.service.js';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { repoA, userA } from '../fixtures/index.js';

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    docProposal: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    commitIntent: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    webhookDelivery: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    processingRun: {
      upsert: vi.fn(),
    },
    repository: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../src/services/github.service.js', () => ({
  githubService: {
    getPullRequestDetails: vi.fn(),
    getFileContent: vi.fn(),
    createDocCommit: vi.fn(),
  },
}));

describe('Documentation Proposal Lifecycle & Concurrency (ADR 0003, V18, V19, V20)', () => {
  const originalReadme = '# Title\n\nOriginal docs\n';
  const baseFileHash = crypto.createHash('sha256').update(originalReadme, 'utf8').digest('hex');

  const mockProposal = {
    id: 'prop-uuid-1',
    repositoryId: repoA.id,
    prNumber: 42,
    headSha: 'head-sha-1111',
    baseFileHash,
    targetPath: 'README.md',
    title: 'Update installation docs',
    description: 'Clarifies setup steps',
    operations: [
      {
        oldText: 'Original docs',
        newText: 'Updated documentation content',
      },
    ],
    previewContent: '# Title\n\nUpdated documentation content\n',
    isFork: false,
    status: 'PENDING_APPROVAL',
    repository: {
      ...repoA,
      user: userA,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case V18: Concurrency Protection, Lineage Guarantee & Mismatch Detection', () => {
    it('locks proposal atomically and commits using Git Data API on valid approval', async () => {
      vi.mocked(prisma.docProposal.findUnique).mockResolvedValueOnce(mockProposal as any);
      // Lock succeeds: 1 row updated
      vi.mocked(prisma.docProposal.updateMany).mockResolvedValueOnce({ count: 1 });

      // GitHub returns open PR with matching HEAD SHA and same repo (not fork)
      vi.mocked(githubService.getPullRequestDetails).mockResolvedValueOnce({
        headSha: 'head-sha-1111',
        headRef: 'feature-branch',
        baseRef: 'main',
        state: 'open',
        isFork: false,
        headRepoFullName: 'alice-developer/alice-project',
        baseRepoFullName: 'alice-developer/alice-project',
      });

      // Target file on GitHub matches baseFileHash
      vi.mocked(githubService.getFileContent).mockResolvedValueOnce({
        content: originalReadme,
        sha: 'blob-sha-original',
      });

      // Commit intent created
      vi.mocked(prisma.commitIntent.create).mockResolvedValueOnce({
        id: 'intent-uuid-1',
        proposalId: 'prop-uuid-1',
        repositoryId: repoA.id,
        prNumber: 42,
        expectedParentSha: 'head-sha-1111',
        expectedContentHash: 'hash-new',
        status: 'PENDING',
      } as any);

      // Git Data API commit succeeds
      vi.mocked(githubService.createDocCommit).mockResolvedValueOnce({
        commitSha: 'commit-sha-new-2222',
        commitUrl: 'https://github.com/alice-developer/alice-project/commit/commit-sha-new-2222',
      });

      vi.mocked(prisma.commitIntent.update).mockResolvedValueOnce({} as any);
      vi.mocked(prisma.docProposal.update).mockResolvedValueOnce({
        ...mockProposal,
        status: 'APPLIED',
        commitSha: 'commit-sha-new-2222',
      } as any);

      const result = await docProposalService.approveProposal('prop-uuid-1', userA.id);

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('commit-sha-new-2222');

      // Verify Git Data API was called with exact branch, parent commit, and non-force
      expect(githubService.createDocCommit).toHaveBeenCalledWith(
        userA.accessToken,
        'alice-developer',
        'alice-project',
        'feature-branch',
        'head-sha-1111',
        'README.md',
        '# Title\n\nUpdated documentation content\n',
        expect.stringContaining('Intent-ID: intent-uuid-1')
      );

      // Verify CommitIntent confirmed
      expect(prisma.commitIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'intent-uuid-1' },
          data: expect.objectContaining({
            status: 'CONFIRMED',
            appliedCommitSha: 'commit-sha-new-2222',
          }),
        })
      );
    });

    it('rejects duplicate concurrent approval requests with 409 conflict when lock is not acquired', async () => {
      vi.mocked(prisma.docProposal.findUnique).mockResolvedValueOnce(mockProposal as any);
      // Lock fails: another concurrent request already acquired lock (count = 0)
      vi.mocked(prisma.docProposal.updateMany).mockResolvedValueOnce({ count: 0 });

      await expect(
        docProposalService.approveProposal('prop-uuid-1', userA.id)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONCURRENT_APPROVAL_CONFLICT',
      });

      expect(githubService.createDocCommit).not.toHaveBeenCalled();
    });

    it('marks proposal STALE and rejects with 409 when PR HEAD advanced before approval', async () => {
      vi.mocked(prisma.docProposal.findUnique).mockResolvedValueOnce(mockProposal as any);
      vi.mocked(prisma.docProposal.updateMany).mockResolvedValueOnce({ count: 1 });

      // PR HEAD advanced to head-sha-diverged
      vi.mocked(githubService.getPullRequestDetails).mockResolvedValueOnce({
        headSha: 'head-sha-diverged-9999',
        headRef: 'feature-branch',
        baseRef: 'main',
        state: 'open',
        isFork: false,
        headRepoFullName: 'alice-developer/alice-project',
        baseRepoFullName: 'alice-developer/alice-project',
      });

      await expect(
        docProposalService.approveProposal('prop-uuid-1', userA.id)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'HEAD_ADVANCED',
      });

      expect(prisma.docProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prop-uuid-1' },
          data: expect.objectContaining({
            status: 'STALE',
            failureReason: expect.stringContaining('HEAD_ADVANCED'),
          }),
        })
      );

      expect(githubService.createDocCommit).not.toHaveBeenCalled();
    });

    it('marks proposal STALE and rejects with 409 when target file content changed concurrently', async () => {
      vi.mocked(prisma.docProposal.findUnique).mockResolvedValueOnce(mockProposal as any);
      vi.mocked(prisma.docProposal.updateMany).mockResolvedValueOnce({ count: 1 });

      vi.mocked(githubService.getPullRequestDetails).mockResolvedValueOnce({
        headSha: 'head-sha-1111',
        headRef: 'feature-branch',
        baseRef: 'main',
        state: 'open',
        isFork: false,
        headRepoFullName: 'alice-developer/alice-project',
        baseRepoFullName: 'alice-developer/alice-project',
      });

      // Target file content diverged from baseline hash
      vi.mocked(githubService.getFileContent).mockResolvedValueOnce({
        content: '# Title\n\nDiverged concurrent changes made to README\n',
        sha: 'blob-sha-diverged',
      });

      await expect(
        docProposalService.approveProposal('prop-uuid-1', userA.id)
      ).rejects.toMatchObject({
        statusCode: 409,
      });

      expect(prisma.docProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prop-uuid-1' },
          data: expect.objectContaining({
            status: expect.stringMatching(/STALE|FAILED/),
          }),
        })
      );

      expect(githubService.createDocCommit).not.toHaveBeenCalled();
    });
  });

  describe('Case V19: Strict Fork PR and Closed PR Write Rejection', () => {
    it('strictly rejects automated commit when proposal is flagged as fork with 403 Forbidden', async () => {
      const forkProposal = {
        ...mockProposal,
        isFork: true,
      };

      vi.mocked(prisma.docProposal.findUnique).mockResolvedValueOnce(forkProposal as any);
      vi.mocked(prisma.docProposal.updateMany).mockResolvedValueOnce({ count: 1 });

      await expect(
        docProposalService.approveProposal('prop-uuid-1', userA.id)
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORK_WRITE_FORBIDDEN',
      });

      expect(prisma.docProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prop-uuid-1' },
          data: expect.objectContaining({
            status: 'FAILED',
            failureReason: expect.stringContaining('FORK_WRITE_FORBIDDEN'),
          }),
        })
      );

      expect(githubService.createDocCommit).not.toHaveBeenCalled();
    });

    it('rejects approval when PR is closed on GitHub with 409 PR_CLOSED', async () => {
      vi.mocked(prisma.docProposal.findUnique).mockResolvedValueOnce(mockProposal as any);
      vi.mocked(prisma.docProposal.updateMany).mockResolvedValueOnce({ count: 1 });

      vi.mocked(githubService.getPullRequestDetails).mockResolvedValueOnce({
        headSha: 'head-sha-1111',
        headRef: 'feature-branch',
        baseRef: 'main',
        state: 'closed',
        isFork: false,
        headRepoFullName: 'alice-developer/alice-project',
        baseRepoFullName: 'alice-developer/alice-project',
      });

      await expect(
        docProposalService.approveProposal('prop-uuid-1', userA.id)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'PR_CLOSED',
      });

      expect(prisma.docProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prop-uuid-1' },
          data: expect.objectContaining({
            status: 'STALE',
            failureReason: expect.stringContaining('PR_CLOSED'),
          }),
        })
      );

      expect(githubService.createDocCommit).not.toHaveBeenCalled();
    });
  });
});
