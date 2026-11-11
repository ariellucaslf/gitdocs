import crypto from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { githubService } from './github.service.js';
import { docPatchService, PatchOperation } from './docPatch.service.js';
import { resolveUserAccessToken } from './crypto.service.js';

export interface CreateProposalInput {
  repositoryId: string;
  prNumber: number;
  headSha: string;
  title: string;
  description?: string;
  targetPath?: string;
  operations: PatchOperation[];
  evidence?: string;
  isFork?: boolean;
  originalFileContent: string | null;
}

export class DocProposalService {
  /**
   * Validates patch operations and creates a new DocProposal in PENDING_APPROVAL status.
   */
  async createProposal(input: CreateProposalInput) {
    const targetPath = input.targetPath || 'README.md';

    const patchResult = docPatchService.applyPatch(
      input.originalFileContent,
      input.operations,
      targetPath
    );

    if (!patchResult.success) {
      throw new Error(`Patch validation failed: [${patchResult.code}] ${patchResult.error}`);
    }

    return prisma.docProposal.create({
      data: {
        repositoryId: input.repositoryId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseFileHash: patchResult.baseFileHash,
        targetPath,
        title: input.title,
        description: input.description,
        operations: input.operations as any,
        evidence: input.evidence,
        previewContent: patchResult.patchedContent,
        isFork: input.isFork ?? false,
        status: 'PENDING_APPROVAL',
      },
    });
  }

  /**
   * Approves and commits a documentation proposal with concurrency control and non-force push.
   * Enforces ADR 0003 & Cases V18, V19:
   * - Atomic lock against duplicate approval requests
   * - Strict rejection of fork PR writes
   * - Re-verifies PR state, HEAD SHA, and target file hash before committing
   * - Git Data API non-force commit with CommitIntent tracking
   */
  async approveProposal(proposalId: string, userId: string) {
    // 1. Retrieve proposal and parent repository
    const proposal = await prisma.docProposal.findUnique({
      where: { id: proposalId },
      include: {
        repository: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!proposal) {
      const error: any = new Error('Proposal not found');
      error.statusCode = 404;
      throw error;
    }

    // 2. Concurrency Lock: Atomically reserve proposal (V18)
    const lockResult = await prisma.docProposal.updateMany({
      where: {
        id: proposalId,
        status: 'PENDING_APPROVAL',
      },
      data: {
        status: 'APPLYING',
      },
    });

    if (lockResult.count === 0) {
      const error: any = new Error(
        `Proposal cannot be approved: current status is '${proposal.status}' (already processed or concurrently locked).`
      );
      error.statusCode = 409;
      error.code = 'CONCURRENT_APPROVAL_CONFLICT';
      throw error;
    }

    // 3. Reject Fork PR writes (ADR 0003, V19)
    if (proposal.isFork) {
      await prisma.docProposal.update({
        where: { id: proposalId },
        data: {
          status: 'FAILED',
          failureReason: 'FORK_WRITE_FORBIDDEN: Documentation changes on fork PRs cannot be written automatically.',
        },
      });

      const error: any = new Error(
        'Automated commits are not permitted for Pull Requests originating from forks.'
      );
      error.statusCode = 403;
      error.code = 'FORK_WRITE_FORBIDDEN';
      throw error;
    }

    const accessToken = resolveUserAccessToken(proposal.repository.user);
    const owner = proposal.repository.owner;
    const repo = proposal.repository.name;

    try {
      // 4. Fetch latest PR status from GitHub to verify freshness (V18, V19)
      const prDetails = await githubService.getPullRequestDetails(
        accessToken,
        owner,
        repo,
        proposal.prNumber
      );

      if (!prDetails || prDetails.state !== 'open') {
        await prisma.docProposal.update({
          where: { id: proposalId },
          data: {
            status: 'STALE',
            failureReason: 'PR_CLOSED: Pull Request is no longer open.',
          },
        });

        const error: any = new Error('Pull Request is closed or unavailable.');
        error.statusCode = 409;
        error.code = 'PR_CLOSED';
        throw error;
      }

      if (prDetails.isFork) {
        await prisma.docProposal.update({
          where: { id: proposalId },
          data: {
            status: 'FAILED',
            failureReason: 'FORK_WRITE_FORBIDDEN: Pull Request head repository differs from base repository.',
          },
        });

        const error: any = new Error('Pull Request originates from a fork repository.');
        error.statusCode = 403;
        error.code = 'FORK_WRITE_FORBIDDEN';
        throw error;
      }

      // Check if PR HEAD SHA advanced since proposal was created (V18)
      if (prDetails.headSha !== proposal.headSha) {
        await prisma.docProposal.update({
          where: { id: proposalId },
          data: {
            status: 'STALE',
            failureReason: `HEAD_ADVANCED: PR head advanced from ${proposal.headSha} to ${prDetails.headSha}.`,
          },
        });

        const error: any = new Error(
          `Pull Request head commit advanced since proposal was generated (expected: ${proposal.headSha}, current: ${prDetails.headSha}). Proposal marked STALE.`
        );
        error.statusCode = 409;
        error.code = 'HEAD_ADVANCED';
        throw error;
      }

      // 5. Fetch current target file at expected HEAD to verify base file hash (V18)
      const currentFile = await githubService.getFileContent(
        accessToken,
        owner,
        repo,
        proposal.targetPath,
        prDetails.headSha
      );

      const currentContent = currentFile ? currentFile.content : null;
      const currentHash = crypto.createHash('sha256').update(currentContent ?? '', 'utf8').digest('hex');

      if (currentHash !== proposal.baseFileHash) {
        await prisma.docProposal.update({
          where: { id: proposalId },
          data: {
            status: 'STALE',
            failureReason: 'FILE_MODIFIED_CONCURRENTLY: Target file content hash diverged from proposal baseline.',
          },
        });

        const error: any = new Error(
          'Target file was modified concurrently. Proposal marked STALE.'
        );
        error.statusCode = 409;
        error.code = 'FILE_MODIFIED_CONCURRENTLY';
        throw error;
      }

      const patchResult = docPatchService.applyPatch(
        currentContent,
        proposal.operations as unknown as PatchOperation[],
        proposal.targetPath
      );

      if (!patchResult.success) {
        await prisma.docProposal.update({
          where: { id: proposalId },
          data: {
            status: 'FAILED',
            failureReason: `PATCH_FAILED: ${patchResult.error}`,
          },
        });

        const error: any = new Error(`Failed to apply patch on current target file: ${patchResult.error}`);
        error.statusCode = 422;
        error.code = patchResult.code;
        throw error;
      }

      // 6. Persist CommitIntent before executing external commit (ADR 0003, V20)
      const intent = await prisma.commitIntent.create({
        data: {
          proposalId: proposal.id,
          repositoryId: proposal.repositoryId,
          prNumber: proposal.prNumber,
          expectedParentSha: proposal.headSha,
          expectedContentHash: patchResult.newContentHash,
          status: 'PENDING',
        },
      });

      const commitMessage = `docs(${proposal.targetPath}): ${proposal.title}\n\nAutomated documentation proposal applied via GitDocs.\nIntent-ID: ${intent.id}`;

      try {
        // 7. Write commit using Git Data API with non-force branch update
        const { commitSha, commitUrl } = await githubService.createDocCommit(
          accessToken,
          owner,
          repo,
          prDetails.headRef,
          proposal.headSha,
          proposal.targetPath,
          patchResult.patchedContent,
          commitMessage
        );

        // 8. Confirm CommitIntent and mark DocProposal as APPLIED
        await prisma.commitIntent.update({
          where: { id: intent.id },
          data: {
            status: 'CONFIRMED',
            appliedCommitSha: commitSha,
          },
        });

        const appliedProposal = await prisma.docProposal.update({
          where: { id: proposal.id },
          data: {
            status: 'APPLIED',
            commitSha,
            commitUrl,
            approvedByUserId: userId,
            approvedAt: new Date(),
          },
        });

        console.log(`✅ [DocProposal] Proposal ${proposalId} committed successfully (${commitSha})`);

        return {
          success: true,
          proposal: appliedProposal,
          commitSha,
          commitUrl,
        };
      } catch (commitErr: unknown) {
        // Abandon intent on commit failure
        await prisma.commitIntent.update({
          where: { id: intent.id },
          data: { status: 'ABANDONED' },
        });

        const errorMessage = commitErr instanceof Error ? commitErr.message : String(commitErr);
        const isConflict = errorMessage.includes('422') || errorMessage.includes('fast-forward');

        await prisma.docProposal.update({
          where: { id: proposal.id },
          data: {
            status: isConflict ? 'STALE' : 'FAILED',
            failureReason: errorMessage,
          },
        });

        throw commitErr;
      }
    } catch (outerErr: unknown) {
      // If error happened after locking but before status updated to APPLIED or STALE, mark as FAILED
      const current = await prisma.docProposal.findUnique({ where: { id: proposalId } });
      if (current && current.status === 'APPLYING') {
        const errorMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        await prisma.docProposal.update({
          where: { id: proposalId },
          data: {
            status: 'FAILED',
            failureReason: errorMsg,
          },
        });
      }
      throw outerErr;
    }
  }

  /**
   * Rejects a documentation proposal.
   */
  async rejectProposal(proposalId: string, _userId: string, reason?: string) {
    const proposal = await prisma.docProposal.findUnique({
      where: { id: proposalId },
    });

    if (!proposal) {
      const error: any = new Error('Proposal not found');
      error.statusCode = 404;
      throw error;
    }

    if (proposal.status !== 'PENDING_APPROVAL') {
      const error: any = new Error(`Proposal cannot be rejected from status '${proposal.status}'`);
      error.statusCode = 409;
      throw error;
    }

    return prisma.docProposal.update({
      where: { id: proposalId },
      data: {
        status: 'REJECTED',
        failureReason: reason || 'Rejected by user',
      },
    });
  }

  /**
   * Fetches proposal details by ID.
   */
  async getProposal(proposalId: string) {
    return prisma.docProposal.findUnique({
      where: { id: proposalId },
      include: {
        repository: true,
        approvedByUser: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
          },
        },
      },
    });
  }

  /**
   * Lists proposals for a repository.
   */
  async listProposals(repositoryId: string, prNumber?: number) {
    return prisma.docProposal.findMany({
      where: {
        repositoryId,
        ...(prNumber ? { prNumber } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        approvedByUser: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
          },
        },
      },
    });
  }
}

export const docProposalService = new DocProposalService();
