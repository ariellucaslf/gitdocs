import { logger } from '../utils/logger.js';
import { Request, Response } from 'express';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { githubService } from '../services/github.service.js';
import { resolveUserAccessToken } from '../services/crypto.service.js';
import { sendSuccess, sendError } from '../utils/response.js';

const eventSchema = z.object({
  action: z.string().min(1),
  repository: z.object({ id: z.number().int().positive() }),
  pull_request: z.object({
    number: z.number().int().positive(), title: z.string().max(1000),
    head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
    base: z.object({ ref: z.string().min(1).max(255) }),
  }),
});
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCESS', 'PARTIAL_SUCCESS', 'ERROR', 'SKIPPED', 'SUPERSEDED']).optional(),
});

export class WebhookController {
  handle = async (req: Request, res: Response): Promise<void> => {
    const deliveryId = req.get('x-github-delivery');
    const event = req.get('x-github-event');
    if (!deliveryId || deliveryId.length > 200 || !event || !req.rawBody) {
      sendError(res, 'Missing delivery ID, event or original payload', 400); return;
    }
    const payloadDigest = crypto.createHash('sha256').update(req.rawBody).digest('hex');
    const acknowledge = (delivery: { payloadDigest: string; admissionStatus: string; processingRunId?: string | null }) => {
      if (delivery.payloadDigest !== payloadDigest) { sendError(res, 'Tampered webhook delivery detected', 409); return; }
      sendSuccess(res, { received: true, duplicate: true, deliveryId, status: delivery.admissionStatus, runId: delivery.processingRunId });
    };
    try {
      const existing = await prisma.webhookDelivery.findUnique({ where: { deliveryId } });
      if (existing) { acknowledge(existing); return; }
      if (event !== 'pull_request') { sendSuccess(res, { message: event === 'ping' ? 'Pong!' : 'Event ignored' }); return; }
      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) { sendError(res, 'Invalid webhook payload structure', 400); return; }
      const { action, pull_request: pr, repository } = parsed.data;
      const repo = await prisma.repository.findUnique({ where: { githubRepoId: repository.id }, include: { user: true } });
      if (!repo) { sendSuccess(res, { message: 'Repository is inactive, skipped processing' }); return; }
      let reason: string | null = null;
      if (!repo.isActive || !repo.desiredActive || repo.provisioningState !== 'ACTIVE') reason = 'MONITORING_DISABLED';
      if (!['opened', 'synchronize', 'reopened'].includes(action)) reason = 'ACTION_IGNORED';
      if (!reason) {
        const intent = await prisma.commitIntent.findFirst({
          where: { repositoryId: repo.id, prNumber: pr.number, status: { in: ['PENDING', 'CONFIRMED'] },
            OR: [{ appliedCommitSha: pr.head.sha }, { preparedCommitSha: pr.head.sha }] },
        });
        if (intent && await githubService.verifyDocCommit(resolveUserAccessToken(repo.user), repo.owner, repo.name, pr.head.sha, intent)) {
          await prisma.$transaction(async tx => {
            await tx.commitIntent.update({ where: { id: intent.id }, data: { status: 'CONFIRMED', appliedCommitSha: pr.head.sha } });
            await tx.docProposal.update({ where: { id: intent.proposalId }, data: { status: 'APPLIED', commitSha: pr.head.sha,
              commitUrl: `https://github.com/${repo.fullName}/commit/${pr.head.sha}` } });
            await tx.webhookDelivery.create({ data: { deliveryId, repositoryId: repo.id, event, action, headSha: pr.head.sha,
              payloadDigest, admissionStatus: 'SKIPPED_SELF_COMMIT', admissionReason: intent.id } });
          });
          sendSuccess(res, { received: true, skipped: true, headSha: pr.head.sha }); return;
        }
      }
      const run = await prisma.$transaction(async tx => {
        const processingRun = reason ? null : await tx.processingRun.upsert({
          where: { repositoryId_prNumber_headSha: { repositoryId: repo.id, prNumber: pr.number, headSha: pr.head.sha } },
          update: {}, create: { repositoryId: repo.id, prNumber: pr.number, prTitle: pr.title, headSha: pr.head.sha, baseRef: pr.base.ref },
        });
        await tx.webhookDelivery.create({ data: { deliveryId, repositoryId: repo.id, event, action, headSha: pr.head.sha,
          payloadDigest, admissionStatus: reason ? 'SKIPPED' : 'ADMITTED', admissionReason: reason, processingRunId: processingRun?.id } });
        return processingRun;
      });
      logger.info('Webhook admitted', { deliveryId, runId: run?.id, repositoryId: repo.id, reason });
      // Only the persistent worker executes a run. The receiver has no fire-and-forget path.
      sendSuccess(res, { received: true, deliveryId, runId: run?.id, status: run?.status ?? 'SKIPPED', reason }, run ? 202 : 200);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.webhookDelivery.findUnique({ where: { deliveryId } }).catch(() => null);
        if (existing) { acknowledge(existing); return; }
      }
      sendError(res, 'Webhook admission unavailable; retry delivery', 503);
    }
  };

  listLogs = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const query = paginationSchema.safeParse(req.query);
    if (!query.success) { sendError(res, 'Invalid pagination or status', 400); return; }
    const { page, limit, status } = query.data;
    const owner = { repository: { userId: req.user.id } };
    try {
      const where = { ...owner, ...(status ? { status } : {}) };
      const [total, runs, success, errors, all] = await Promise.all([
        prisma.processingRun.count({ where }),
        prisma.processingRun.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
          include: { repository: { select: { name: true, fullName: true, owner: true } }, steps: true } }),
        prisma.processingRun.count({ where: { ...owner, status: 'SUCCESS' } }),
        prisma.processingRun.count({ where: { ...owner, status: { in: ['ERROR', 'PARTIAL_SUCCESS'] } } }),
        prisma.processingRun.count({ where: owner }),
      ]);
      const items = runs.map(run => ({ ...run, rawDiffSize: run.rawDiffSize ?? 0, errorMessage: run.lastErrorCode,
        responseCommentUrl: run.commentUrl, analysisResult: undefined, commentBody: undefined }));
      sendSuccess(res, { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        aggregates: { successfulReviews: success, failedReviews: errors, totalRuns: all } });
    } catch { sendError(res, 'Failed to fetch webhook logs', 500); }
  };
}
export const webhookController = new WebhookController();
