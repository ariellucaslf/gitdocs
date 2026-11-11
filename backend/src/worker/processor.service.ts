import { logger } from '../utils/logger.js';
import { Prisma, RunStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { githubService } from '../services/github.service.js';
import { geminiService } from '../services/gemini.service.js';
import { docProposalService } from '../services/docProposal.service.js';
import { resolveUserAccessToken } from '../services/crypto.service.js';
import { formatReviewComment } from '../utils/commentFormatter.js';
import { externalStatus, retryDelay } from '../utils/errors.js';
import { AnalysisResult } from '../types/analysis.js';
import { queueService, LeasedRun } from './queue.service.js';

class LeaseLost extends Error {}
class RunStopped extends Error { constructor(public status: RunStatus, public code: string) { super(code); } }

export class JobProcessorService {
  async processRun(run: LeasedRun, workerId: string): Promise<void> {
    const startedAt = Date.now();
    logger.info('Processing run started', { runId: run.id, workerId, attempt: run.attemptCount });
    let lostLease = false;
    const where = { id: run.id, leaseOwner: workerId, leaseVersion: run.leaseVersion, status: 'RUNNING' as const, leaseUntil: { gt: new Date() } };
    const write = async (data: Prisma.ProcessingRunUpdateManyMutationInput) => {
      const result = await prisma.processingRun.updateMany({ where: { ...where, leaseUntil: { gt: new Date() } }, data });
      if (result.count !== 1) throw new LeaseLost();
    };
    const heartbeat = setInterval(() => {
      queueService.renewLease(run.id, workerId, run.leaseVersion).then(ok => { if (!ok) lostLease = true; }).catch(() => { lostLease = true; });
    }, 30000);
    const guard = async () => {
      if (lostLease || !await queueService.renewLease(run.id, workerId, run.leaseVersion)) throw new LeaseLost();
      const repo = await prisma.repository.findUnique({ where: { id: run.repositoryId }, include: { user: true } });
      if (!repo?.isActive || !repo.desiredActive || repo.provisioningState !== 'ACTIVE') throw new RunStopped('SKIPPED', 'MONITORING_DISABLED');
      const token = resolveUserAccessToken(repo.user);
      const pr = await githubService.getPullRequestDetails(token, repo.owner, repo.name, run.prNumber);
      if (!pr || pr.state !== 'open') throw new RunStopped('SKIPPED', 'PR_CLOSED');
      if (pr.headSha !== run.headSha) throw new RunStopped('SUPERSEDED', 'HEAD_SHA_SUPERSEDED');
      return { repo, token, pr };
    };
    const step = async (stepName: string, status: 'RUNNING' | 'SUCCESS' | 'ERROR' | 'SKIPPED', error?: string, externalId?: string) => {
      // Lock and fence the run in the same transaction as the step transition.
      await prisma.$transaction(async tx => {
        const owner = await tx.processingRun.updateMany({ where: { ...where, leaseUntil: { gt: new Date() } }, data: { updatedAt: new Date() } });
        if (owner.count !== 1) throw new LeaseLost();
        const data = { status, attempt: run.attemptCount, error: error ?? null, externalId,
          ...(status === 'RUNNING' ? { startedAt: new Date() } : { finishedAt: new Date() }) };
        await tx.processingStep.upsert({ where: { runId_stepName: { runId: run.id, stepName } }, update: data, create: { runId: run.id, stepName, ...data } });
      });
      logger.info('Processing step updated', { runId: run.id, stepName, status });
    };
    let currentStep = 'FETCH_DIFF';
    let hasPublished = !!run.commentUrl;
    try {
      let { repo, token } = await guard();
      let analysis = run.analysisResult as AnalysisResult | null;
      if (!analysis || analysis.kind !== 'analyzed') {
        await step('FETCH_DIFF', 'RUNNING');
        const rawDiff = await githubService.getPullRequestDiff(token, repo.owner, repo.name, run.prNumber);
        const context = await guard(); // The diff endpoint tracks a moving PR: verify the revision again.
        await write({ rawDiffSize: Buffer.byteLength(rawDiff, 'utf8') });
        await step('FETCH_DIFF', 'SUCCESS');
        currentStep = 'AI_ANALYSIS';
        await step(currentStep, 'RUNNING');
        const readme = await githubService.getFileContent(token, repo.owner, repo.name, 'README.md', run.headSha);
        analysis = await geminiService.analyzePullRequest(run.prTitle, null, rawDiff, readme?.content ?? null);
        if (analysis.kind === 'skipped') {
          await step(currentStep, 'SKIPPED', analysis.reason);
          await write({ status: 'SKIPPED', lastErrorCode: analysis.reason });
          return;
        }
        if (analysis.kind === 'failed') {
          await step(currentStep, 'ERROR', `AI_${analysis.code}`);
          const retry = analysis.retryable && run.attemptCount < run.maxAttempts;
          await write({ status: retry ? 'RETRY_WAIT' : 'ERROR', lastErrorCode: `AI_${analysis.code}`,
            availableAt: new Date(Date.now() + (run.attemptCount === 1 ? 30000 : 120000)) });
          return;
        }
        // Durable result prevents a recovered run from spending tokens or changing its review.
        await write({ analysisResult: analysis as unknown as Prisma.InputJsonValue });
        await step(currentStep, 'SUCCESS');
        repo = context.repo; token = context.token;
      }
      const marker = `<!-- gitdocs-run:${run.id} -->`;
      const commentBody = run.commentBody || `${marker}\nAnalyzed commit: \`${run.headSha}\`\n\n${formatReviewComment({ analysis: analysis.data, usage: analysis.usage, truncated: analysis.truncated })}`;
      await write({ commentBody });
      currentStep = 'PUBLISH_COMMENT';
      await step(currentStep, 'RUNNING');
      ({ repo, token } = await guard());
      // A failed reconciliation is an error, never evidence that no comment exists.
      let commentUrl = await githubService.findPullRequestComment(token, repo.owner, repo.name, run.prNumber, marker);
      if (!commentUrl) {
        await guard();
        commentUrl = await githubService.postPullRequestComment(token, repo.owner, repo.name, run.prNumber, commentBody);
      }
      hasPublished = true;
      await write({ commentUrl });
      await step(currentStep, 'SUCCESS', undefined, commentUrl);
      if (analysis.data.suggestedDocUpdate) {
        currentStep = 'DOC_PROPOSAL';
        await step(currentStep, 'RUNNING');
        const { pr } = await guard();
        const original = await githubService.getFileContent(token, repo.owner, repo.name, 'README.md', run.headSha);
        await docProposalService.createProposal({
          runId: run.id, repositoryId: repo.id, prNumber: run.prNumber, headSha: run.headSha,
          title: analysis.data.suggestedDocUpdate.title, description: analysis.data.suggestedDocUpdate.description,
          targetPath: 'README.md', operations: analysis.data.suggestedDocUpdate.operations,
          evidence: analysis.data.suggestedDocUpdate.evidence, isFork: pr.isFork, originalFileContent: original?.content ?? null,
        });
        await step(currentStep, 'SUCCESS');
      }
      await write({ status: 'SUCCESS', lastErrorCode: null });
    } catch (error) {
      if (error instanceof LeaseLost || lostLease) return; // An old owner cannot overwrite the replacement worker.
      if (error instanceof RunStopped) {
        await write({ status: error.status, lastErrorCode: error.code }).catch(() => {});
        return;
      }
      const status = externalStatus(error);
      const retryable = status === undefined || status === 429 || status >= 500 || (status === 403 && retryDelay(error) > 0);
      const retry = retryable && run.attemptCount < run.maxAttempts;
      const code = `PROCESSING_${currentStep}_FAILED`;
      await step(currentStep, 'ERROR', code).catch(() => {});
      await write({ status: retry ? 'RETRY_WAIT' : hasPublished ? 'PARTIAL_SUCCESS' : 'ERROR', lastErrorCode: code,
        availableAt: new Date(Date.now() + Math.max(retryDelay(error), run.attemptCount === 1 ? 30000 : 120000)) }).catch(() => {});
    } finally {
      logger.info('Processing attempt finished', { runId: run.id, workerId, durationMs: Date.now() - startedAt, lostLease });
      clearInterval(heartbeat);
      await queueService.releaseLease(run.id, workerId, run.leaseVersion).catch(() => {});
    }
  }
}
export const jobProcessorService = new JobProcessorService();
