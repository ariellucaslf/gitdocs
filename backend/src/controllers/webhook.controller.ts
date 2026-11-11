import { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';
import { prProcessorService } from '../services/prProcessor.service.js';
import { sendSuccess, sendError } from '../utils/response.js';

export class WebhookController {
  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const event = req.headers['x-github-event'] as string;

      // Handle ping event when webhook is registered
      if (event === 'ping') {
        console.log('🏓 GitHub Ping Webhook received');
        sendSuccess(res, { message: 'Pong! Webhook registered successfully.' });
        return;
      }

      if (event !== 'pull_request') {
        sendSuccess(res, { message: `Event ${event} ignored. Only 'pull_request' is handled.` });
        return;
      }

      const { action, pull_request, repository } = req.body;

      if (
        !repository ||
        !pull_request ||
        typeof repository.id !== 'number' ||
        repository.id <= 0 ||
        typeof pull_request.number !== 'number' ||
        pull_request.number <= 0
      ) {
        sendError(res, 'Invalid webhook payload structure', 400);
        return;
      }

      console.log(`📥 PR Event received: ${action} on ${repository.full_name} (#${pull_request.number})`);

      // Check if repository is active and confirmed in our database
      const dbRepo = await prisma.repository.findUnique({
        where: { githubRepoId: repository.id },
      });

      if (!dbRepo || !dbRepo.isActive || !dbRepo.desiredActive || dbRepo.provisioningState !== 'ACTIVE') {
        console.log(`⏭️ Repository ${repository.full_name} is not monitored or inactive.`);
        sendSuccess(res, { message: 'Repository is inactive, skipped processing' });
        return;
      }

      // Allowed PR actions
      const triggerActions = ['opened', 'synchronize', 'reopened'];
      if (!triggerActions.includes(action)) {
        sendSuccess(res, { message: `PR action '${action}' ignored` });
        return;
      }

      // Initial Webhook Log creation (PENDING)
      const log = await prisma.webhookLog.create({
        data: {
          repositoryId: dbRepo.id,
          prNumber: pull_request.number,
          prTitle: pull_request.title || 'Untitled PR',
          status: 'PENDING',
          rawDiffSize: 0,
        },
      });

      // Dispatch async background processing
      prProcessorService
        .processPullRequest(log.id, dbRepo.id, pull_request, repository)
        .catch((err) => console.error('💥 Background PR processing failed unexpectedly:', err));

      // Respond promptly to GitHub with HTTP 202 Accepted
      sendSuccess(res, {
        message: 'Webhook received and queued for processing',
        logId: log.id,
        status: 'PENDING',
      }, 202);
    } catch (error) {
      console.error('❌ WebhookController.handle error:', error);
      sendError(res, 'Internal server error while processing webhook', 500);
    }
  };

  listLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        sendError(res, 'Unauthorized', 401);
        return;
      }

      const logs = await prisma.webhookLog.findMany({
        where: {
          repository: {
            userId: req.user.id,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          repository: {
            select: {
              name: true,
              fullName: true,
              owner: true,
            },
          },
        },
      });

      sendSuccess(res, logs);
    } catch (error) {
      console.error('❌ WebhookController.listLogs error:', error);
      sendError(res, 'Failed to fetch webhook logs', 500);
    }
  };
}

export const webhookController = new WebhookController();
