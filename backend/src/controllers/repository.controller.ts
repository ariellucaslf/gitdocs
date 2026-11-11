import { logSafeError } from '../utils/logger.js';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Repository } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { githubService } from '../services/github.service.js';
import { resolveUserAccessToken } from '../services/crypto.service.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { env } from '../config/env.js';
import { repositoryProvisioningService } from '../services/repositoryProvisioning.service.js';
import { HttpError } from '../utils/errors.js';

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

      const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(50),
        search: z.string().max(200).default(''), filter: z.enum(['all', 'active', 'inactive']).default('all') }).safeParse(req.query);
      if (!query.success) { sendError(res, 'Invalid repository query', 400); return; }
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

      const { page, limit, filter } = query.data;
      const search = query.data.search.toLowerCase();
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
        pendingProposals: await prisma.docProposal.count({ where: { repository: { userId: req.user.id }, status: 'PENDING_APPROVAL' } }),
        aiModel: env.GEMINI_MODEL || 'Not configured',
        totalRepositories: ghRepos.length,
        activeRepositories: combined.filter((r) => r.isActive).length,
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
      logSafeError('❌ RepositoryController.list error:', error);
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
          `Invalid payload: ${parsed.error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`,
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
        logSafeError(`Failed to verify repository ${githubRepoId} on GitHub:`, ghError);
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

      if (isActive && (!env.GITHUB_WEBHOOK_URL || !env.GITHUB_WEBHOOK_SECRET)) {
        sendError(res, 'Webhook configuration is missing on the server', 503); return;
      }
      const result = await repositoryProvisioningService.request(req.user.id, githubRepoId, isActive, {
        name: ghRepo.name, fullName: ghRepo.fullName, owner: ghRepo.owner,
      });
      sendSuccess(res, result);
    } catch (error) {
      logSafeError('❌ RepositoryController.toggle error:', error);
      sendError(res, error instanceof HttpError ? error.code : 'Failed to update repository settings', error instanceof HttpError ? error.statusCode : 500);
    }
  };
}

export const repositoryController = new RepositoryController();
