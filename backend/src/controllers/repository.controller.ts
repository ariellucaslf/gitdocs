import { Request, Response } from 'express';
import { z } from 'zod';
import { Repository } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { githubService } from '../services/github.service.js';
import { resolveUserAccessToken } from '../services/crypto.service.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { env } from '../config/env.js';

const toggleRepoSchema = z.object({
  githubRepoId: z.number().int().positive(),
  isActive: z.boolean(),
  name: z.string().optional(),
  fullName: z.string().optional(),
  owner: z.string().optional(),
  autoCommitReadme: z.boolean().optional(),
});

export class RepositoryController {
  list = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        sendError(res, 'Unauthorized', 401);
        return;
      }

      const accessToken = resolveUserAccessToken(req.user);
      const ghRepos = await githubService.listUserRepositories(accessToken);
      const dbRepos: Repository[] = await prisma.repository.findMany({
        where: { userId: req.user.id },
      });

      const dbMap = new Map<number, Repository>(dbRepos.map((r: Repository) => [r.githubRepoId, r]));

      const combined = ghRepos.map((repo) => {
        const tracked = dbMap.get(repo.id);
        return {
          ...repo,
          dbId: tracked?.id ?? null,
          isActive: tracked?.isActive ?? false,
          desiredActive: tracked?.desiredActive ?? false,
          provisioningState: tracked?.provisioningState ?? 'DISABLED',
          lastErrorCode: tracked?.lastErrorCode ?? null,
          autoCommitReadme: false, // suspended for safety (ADR 0003)
          webhookId: tracked?.webhookId ?? null,
        };
      });

      const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : '';
      const filter = req.query.filter as 'all' | 'active' | 'inactive' | undefined;
      const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1;
      const limit = req.query.limit ? Math.min(100, Math.max(1, Number(req.query.limit))) : 50;
      const skip = (page - 1) * limit;

      let filtered = combined;
      if (search) {
        filtered = filtered.filter(
          (r) => r.name.toLowerCase().includes(search) || r.fullName.toLowerCase().includes(search)
        );
      }
      if (filter === 'active') {
        filtered = filtered.filter((r) => r.isActive);
      } else if (filter === 'inactive') {
        filtered = filtered.filter((r) => !r.isActive);
      }

      const total = filtered.length;
      const paginatedItems = filtered.slice(skip, skip + limit);
      const totalPages = Math.ceil(total / limit) || 1;

      // Real aggregates calculation (ADR 0001, V23)
      const aggregates = {
        totalRepositories: ghRepos.length,
        activeRepositories: dbRepos.filter((r) => r.isActive).length,
        errorRepositories: dbRepos.filter((r) => r.provisioningState === 'ERROR').length,
      };

      sendSuccess(res, {
        items: paginatedItems,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
        aggregates,
      });
    } catch (error) {
      console.error('❌ RepositoryController.list error:', error);
      sendError(res, 'Failed to fetch repositories', 500);
    }
  };

  toggle = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        sendError(res, 'Unauthorized', 401);
        return;
      }

      const parsed = toggleRepoSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          `Invalid payload: ${parsed.error.errors.map((e: z.ZodIssue) => e.message).join(', ')}`,
          400
        );
        return;
      }

      const { githubRepoId, isActive } = parsed.data;

      // 1. Multi-Tenant Authorization Check (A01 / V01)
      const existing = await prisma.repository.findUnique({
        where: { githubRepoId },
      });

      if (existing && existing.userId !== req.user.id) {
        // Must return 404 without leaking resource existence or performing external calls
        sendError(res, 'Repository not found', 404);
        return;
      }

      const accessToken = resolveUserAccessToken(req.user);

      // 2. Fetch canonical repository metadata and verify permissions on GitHub (A01 / V02)
      let ghRepo;
      try {
        ghRepo = await githubService.getRepositoryById(accessToken, githubRepoId);
      } catch (ghError) {
        console.error(`Failed to verify repository ${githubRepoId} on GitHub:`, ghError);
        sendError(res, 'Repository not found on GitHub or inaccessible', 404);
        return;
      }

      // V02: Enforce administrative permissions before modifying webhooks
      if (!ghRepo.permissions || !ghRepo.permissions.admin) {
        sendError(
          res,
          'Administrative permissions required on the GitHub repository to manage webhooks',
          403
        );
        return;
      }

      const canonicalName = ghRepo.name;
      const canonicalFullName = ghRepo.fullName;
      const canonicalOwner = ghRepo.owner;

      // 3. Activation Flow
      if (isActive) {
        const webhookUrl = env.GITHUB_WEBHOOK_URL;
        if (!webhookUrl) {
          sendError(res, 'Server configuration error: GITHUB_WEBHOOK_URL is not configured', 500);
          return;
        }

        // Reserve intent in database first (PROVISIONING)
        const reservedRepo = await prisma.repository.upsert({
          where: { githubRepoId },
          update: {
            desiredActive: true,
            provisioningState: 'PROVISIONING',
            lastErrorCode: null,
            name: canonicalName,
            fullName: canonicalFullName,
            owner: canonicalOwner,
          },
          create: {
            githubRepoId,
            name: canonicalName,
            fullName: canonicalFullName,
            owner: canonicalOwner,
            desiredActive: true,
            isActive: false, // Never mark ACTIVE until webhook is confirmed on GitHub
            provisioningState: 'PROVISIONING',
            userId: req.user.id,
          },
        });

        // Provision webhook on GitHub
        try {
          const webhookId = await githubService.createRepositoryWebhook(
            accessToken,
            canonicalOwner,
            canonicalName,
            webhookUrl
          );

          // Transition to ACTIVE upon confirmation
          const activeRepo = await prisma.repository.update({
            where: { id: reservedRepo.id },
            data: {
              isActive: true,
              desiredActive: true,
              provisioningState: 'ACTIVE',
              webhookId,
              lastErrorCode: null,
            },
          });

          sendSuccess(res, activeRepo);
          return;
        } catch (webhookError: unknown) {
          console.error(`Failed to provision webhook on GitHub for ${canonicalFullName}:`, webhookError);
          const errorCode =
            webhookError instanceof Error ? webhookError.message : 'WEBHOOK_PROVISIONING_FAILED';

          // V06: State transitions to ERROR, retains desiredActive and webhookId if any, but isActive stays false
          const errorRepo = await prisma.repository.update({
            where: { id: reservedRepo.id },
            data: {
              isActive: false,
              desiredActive: true,
              provisioningState: 'ERROR',
              lastErrorCode: errorCode,
            },
          });

          sendSuccess(res, errorRepo);
          return;
        }
      }

      // 4. Deactivation Flow
      if (!existing) {
        sendError(res, 'Repository is not active or monitored', 404);
        return;
      }

      // Pause processing immediately
      await prisma.repository.update({
        where: { id: existing.id },
        data: {
          desiredActive: false,
          isActive: false,
        },
      });

      let deletionSucceeded = true;
      if (existing.webhookId) {
        try {
          await githubService.deleteRepositoryWebhook(
            accessToken,
            canonicalOwner,
            canonicalName,
            existing.webhookId
          );
        } catch (delError: unknown) {
          console.error(`Failed to delete webhook on GitHub for ${canonicalFullName}:`, delError);
          deletionSucceeded = false;
        }
      }

      // V07: If deletion failed, retain webhookId and mark ERROR so retry/reconciliation is possible
      const deactivatedRepo = await prisma.repository.update({
        where: { id: existing.id },
        data: {
          isActive: false,
          desiredActive: false,
          provisioningState: deletionSucceeded ? 'DISABLED' : 'ERROR',
          webhookId: deletionSucceeded ? null : existing.webhookId,
          lastErrorCode: deletionSucceeded ? null : 'WEBHOOK_DELETION_FAILED',
        },
      });

      sendSuccess(res, deactivatedRepo);
    } catch (error) {
      console.error('❌ RepositoryController.toggle error:', error);
      sendError(res, 'Failed to update repository settings', 500);
    }
  };
}

export const repositoryController = new RepositoryController();
