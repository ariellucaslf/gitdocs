import { prisma } from '../config/prisma.js';
import { githubService } from '../services/github.service.js';
import { geminiService } from '../services/gemini.service.js';
import { docProposalService } from '../services/docProposal.service.js';
import { formatReviewComment } from '../utils/commentFormatter.js';
import { queueService } from './queue.service.js';

export class JobProcessorService {
  /**
   * Executes a leased ProcessingRun through discrete, auditable steps with reconciliation.
   */
  async processRun(run: any, workerId: string): Promise<void> {
    const runId = run.id;
    const dbRepo = run.repository;
    const user = dbRepo?.user;

    // Start background heartbeat to renew lease while processing
    const heartbeat = setInterval(() => {
      queueService.renewLease(runId, workerId, 60).catch((err) => {
        console.warn(`[WorkerHeartbeat] Failed to renew lease for run ${runId}:`, err);
      });
    }, 30000);

    try {
      if (!user || !user.accessToken) {
        throw new Error(`Authentication token missing for repository ID: ${dbRepo?.id}`);
      }

      const accessToken = user.accessToken;
      const owner = dbRepo.owner;
      const repoName = dbRepo.name;
      const prNumber = run.prNumber;

      // Check for Head SHA staleness / PR state on GitHub (Case V16)
      const currentPr = await githubService.getPullRequestHeadSha(accessToken, owner, repoName, prNumber);

      if (currentPr && currentPr.headSha !== run.headSha) {
        console.log(`⏭️ [Worker] Run ${runId} is SUPERSEDED (expected: ${run.headSha}, GitHub head: ${currentPr.headSha}).`);

        await prisma.processingStep.upsert({
          where: { runId_stepName: { runId, stepName: 'FETCH_DIFF' } },
          update: { status: 'SKIPPED', error: 'Head SHA superseded by new commit on GitHub' },
          create: {
            runId,
            stepName: 'FETCH_DIFF',
            status: 'SKIPPED',
            error: 'Head SHA superseded by new commit on GitHub',
          },
        });

        await prisma.processingRun.update({
          where: { id: runId },
          data: { status: 'SUPERSEDED', lastErrorCode: 'HEAD_SHA_SUPERSEDED' },
        });

        await prisma.webhookLog.update({
          where: { id: runId },
          data: { status: 'SUCCESS', errorMessage: 'Superseded by newer commit' },
        }).catch(() => {});

        return;
      }

      // Step 1: FETCH_DIFF
      await prisma.processingStep.upsert({
        where: { runId_stepName: { runId, stepName: 'FETCH_DIFF' } },
        update: { status: 'RUNNING', startedAt: new Date() },
        create: { runId, stepName: 'FETCH_DIFF', status: 'RUNNING', startedAt: new Date() },
      });

      const rawDiff = await githubService.getPullRequestDiff(accessToken, owner, repoName, prNumber);
      const rawDiffSize = Buffer.byteLength(rawDiff, 'utf8');

      await prisma.processingStep.update({
        where: { runId_stepName: { runId, stepName: 'FETCH_DIFF' } },
        data: { status: 'SUCCESS', finishedAt: new Date() },
      });

      await prisma.processingRun.update({
        where: { id: runId },
        data: { rawDiffSize },
      });

      // Step 2: AI_ANALYSIS
      await prisma.processingStep.upsert({
        where: { runId_stepName: { runId, stepName: 'AI_ANALYSIS' } },
        update: { status: 'RUNNING', startedAt: new Date() },
        create: { runId, stepName: 'AI_ANALYSIS', status: 'RUNNING', startedAt: new Date() },
      });

      const analysis = await geminiService.analyzePullRequest(run.prTitle, null, rawDiff);

      if (analysis.kind === 'skipped') {
        await prisma.processingStep.update({
          where: { runId_stepName: { runId, stepName: 'AI_ANALYSIS' } },
          data: { status: 'SKIPPED', finishedAt: new Date() },
        });

        await prisma.processingRun.update({
          where: { id: runId },
          data: { status: 'SUCCESS', lastErrorCode: `Skipped: ${analysis.reason}` },
        });

        await prisma.webhookLog.update({
          where: { id: runId },
          data: { status: 'SUCCESS', errorMessage: `Skipped: ${analysis.reason}` },
        }).catch(() => {});

        return;
      }

      if (analysis.kind === 'failed') {
        await prisma.processingStep.update({
          where: { runId_stepName: { runId, stepName: 'AI_ANALYSIS' } },
          data: {
            status: 'ERROR',
            error: `AI_${analysis.code}: ${analysis.message}`,
            finishedAt: new Date(),
          },
        });

        // Determine if retry is eligible
        if (analysis.retryable && run.attemptCount < run.maxAttempts) {
          const backoffSeconds = run.attemptCount === 1 ? 30 : 120;
          const availableAt = new Date(Date.now() + backoffSeconds * 1000);

          await prisma.processingRun.update({
            where: { id: runId },
            data: {
              status: 'RETRY_WAIT',
              availableAt,
              lastErrorCode: `AI_${analysis.code}`,
              leaseOwner: null,
              leaseUntil: null,
            },
          });
        } else {
          await prisma.processingRun.update({
            where: { id: runId },
            data: {
              status: 'ERROR',
              lastErrorCode: `AI_${analysis.code}`,
            },
          });

          await prisma.webhookLog.update({
            where: { id: runId },
            data: {
              status: 'ERROR',
              errorMessage: `AI_${analysis.code}: ${analysis.message}`,
            },
          }).catch(() => {});
        }

        return;
      }

      await prisma.processingStep.update({
        where: { runId_stepName: { runId, stepName: 'AI_ANALYSIS' } },
        data: { status: 'SUCCESS', finishedAt: new Date() },
      });

      // Generate DocProposal in PENDING_APPROVAL when AI suggests documentation update (ADR 0003, V17)
      if (analysis.data.suggestedDocUpdate) {
        try {
          const prDetails = await githubService.getPullRequestDetails(
            accessToken,
            owner,
            repoName,
            prNumber
          );

          const isFork = prDetails?.isFork ?? false;
          const targetPath = analysis.data.suggestedDocUpdate.targetFile || 'README.md';

          const currentFile = await githubService.getFileContent(
            accessToken,
            owner,
            repoName,
            targetPath,
            run.headSha
          );

          const originalContent = currentFile ? currentFile.content : null;
          const operations = originalContent === null
            ? [{ oldText: '', newText: analysis.data.suggestedDocUpdate.proposedContent }]
            : [{ oldText: originalContent, newText: analysis.data.suggestedDocUpdate.proposedContent }];

          await docProposalService.createProposal({
            repositoryId: run.repositoryId,
            prNumber: run.prNumber,
            headSha: run.headSha,
            title: analysis.data.suggestedDocUpdate.title,
            description: analysis.data.suggestedDocUpdate.description,
            targetPath,
            operations,
            evidence: analysis.data.suggestedDocUpdate.evidence,
            isFork,
            originalFileContent: originalContent,
          });

          console.log(`📝 [Worker] Generated documentation proposal for PR #${prNumber} (${targetPath})`);
        } catch (proposalErr) {
          console.warn(`⚠️ [Worker] DocProposal generation skipped for PR #${prNumber}:`, proposalErr);
        }
      }

      // Step 3: PUBLISH_COMMENT (with reconciliation check, V15)
      await prisma.processingStep.upsert({
        where: { runId_stepName: { runId, stepName: 'PUBLISH_COMMENT' } },
        update: { status: 'RUNNING', startedAt: new Date() },
        create: { runId, stepName: 'PUBLISH_COMMENT', status: 'RUNNING', startedAt: new Date() },
      });

      // Check if comment was already created (e.g. timeout after external creation)
      let commentUrl = await githubService.findPullRequestComment(
        accessToken,
        owner,
        repoName,
        prNumber,
        '<!-- gitdocs-review -->'
      );

      if (!commentUrl) {
        const commentBody = formatReviewComment({
          analysis: analysis.data,
          usage: analysis.usage,
          truncated: analysis.truncated,
        });

        commentUrl = await githubService.postPullRequestComment(
          accessToken,
          owner,
          repoName,
          prNumber,
          commentBody
        );
      } else {
        console.log(`ℹ️ [Worker] Reconciled existing comment on PR #${prNumber} without creating duplicate.`);
      }

      await prisma.processingStep.update({
        where: { runId_stepName: { runId, stepName: 'PUBLISH_COMMENT' } },
        data: {
          status: 'SUCCESS',
          externalId: commentUrl,
          finishedAt: new Date(),
        },
      });

      // Mark run as complete
      await prisma.processingRun.update({
        where: { id: runId },
        data: {
          status: 'SUCCESS',
          commentUrl,
          lastErrorCode: null,
        },
      });

      await prisma.webhookLog.update({
        where: { id: runId },
        data: {
          status: 'SUCCESS',
          responseCommentUrl: commentUrl,
        },
      }).catch(() => {});

      console.log(`✨ [Worker] Successfully completed processing for run ${runId}`);
    } catch (err: unknown) {
      console.error(`💥 [Worker] Unhandled error during run ${runId}:`, err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      await prisma.processingRun.update({
        where: { id: runId },
        data: {
          status: 'ERROR',
          lastErrorCode: errorMessage,
        },
      }).catch(() => {});

      await prisma.webhookLog.update({
        where: { id: runId },
        data: {
          status: 'ERROR',
          errorMessage,
        },
      }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      await queueService.releaseLease(runId, workerId).catch(() => {});
    }
  }
}

export const jobProcessorService = new JobProcessorService();
