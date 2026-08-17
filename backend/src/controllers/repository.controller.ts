import { Request, Response } from 'express';
import { z } from 'zod';
import { Repository } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { githubService } from '../services/github.service.js';
import { sendSuccess, sendError } from '../utils/response.js';

const toggleRepoSchema = z.object({
  githubRepoId: z.number(),
  name: z.string(),
  fullName: z.string(),
  owner: z.string(),
  isActive: z.boolean(),
  autoCommitReadme: z.boolean().default(false),
  webhookUrl: z.string().url().optional(),
});

export class RepositoryController {
  list = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        sendError(res, 'Unauthorized', 401);
        return;
      }

      const ghRepos = await githubService.listUserRepositories(req.user.accessToken);
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
          autoCommitReadme: tracked?.autoCommitReadme ?? false,
          webhookId: tracked?.webhookId ?? null,
        };
      });

      sendSuccess(res, combined);
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
        sendError(res, `Invalid payload: ${parsed.error.errors.map((e: z.ZodIssue) => e.message).join(', ')}`, 400);
        return;
      }

      const { githubRepoId, name, fullName, owner, isActive, autoCommitReadme, webhookUrl } = parsed.data;

      let existing = await prisma.repository.findUnique({
        where: { githubRepoId },
      });

      let webhookId = existing?.webhookId ?? null;

      // Handling Webhook Registration / Removal
      if (isActive && !webhookId && webhookUrl) {
        try {
          webhookId = await githubService.createRepositoryWebhook(
            req.user.accessToken,
            owner,
            name,
            webhookUrl
          );
        } catch (webhookError) {
          console.error('⚠️ Could not create webhook on GitHub:', webhookError);
          // Proceed with database state update
        }
      } else if (!isActive && webhookId) {
        try {
          await githubService.deleteRepositoryWebhook(
            req.user.accessToken,
            owner,
            name,
            webhookId
          );
          webhookId = null;
        } catch (webhookError) {
          console.error('⚠️ Could not remove webhook on GitHub:', webhookError);
          webhookId = null;
        }
      }

      const savedRepo = await prisma.repository.upsert({
        where: { githubRepoId },
        update: {
          isActive,
          autoCommitReadme,
          webhookId,
          name,
          fullName,
          owner,
        },
        create: {
          githubRepoId,
          name,
          fullName,
          owner,
          isActive,
          autoCommitReadme,
          webhookId,
          userId: req.user.id,
        },
      });

      sendSuccess(res, savedRepo);
    } catch (error) {
      console.error('❌ RepositoryController.toggle error:', error);
      sendError(res, 'Failed to update repository settings', 500);
    }
  };
}

export const repositoryController = new RepositoryController();
