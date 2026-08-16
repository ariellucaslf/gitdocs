import { Request, Response, NextFunction } from 'express';
import { Octokit } from '@octokit/rest';
import { prisma } from '../config/prisma.js';
import { sendError } from '../utils/response.js';

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendError(res, 'Authentication token missing or malformed', 401);
      return;
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      sendError(res, 'Invalid authorization token', 401);
      return;
    }

    const octokit = new Octokit({ auth: token });
    const { data: ghUser } = await octokit.rest.users.getAuthenticated();

    if (!ghUser || !ghUser.id) {
      sendError(res, 'Failed to authenticate with GitHub', 401);
      return;
    }

    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { githubId: ghUser.id },
      update: {
        username: ghUser.login,
        email: ghUser.email ?? null,
        avatarUrl: ghUser.avatar_url ?? null,
        accessToken: token,
      },
      create: {
        githubId: ghUser.id,
        username: ghUser.login,
        email: ghUser.email ?? null,
        avatarUrl: ghUser.avatar_url ?? null,
        accessToken: token,
      },
    });

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Auth Middleware Error:', error);
    sendError(res, 'Unauthorized: Invalid or expired GitHub token', 401);
  }
};
