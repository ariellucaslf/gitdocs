import { Request, Response, NextFunction } from 'express';
import { Octokit } from '@octokit/rest';
import { prisma } from '../config/prisma.js';
import { cryptoService } from '../services/crypto.service.js';
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

    // 1. Check if token is a signed internal assertion from Next.js BFF (ADR 0002, V21)
    if (token.split('.').length === 3) {
      let assertion;
      try {
        assertion = cryptoService.verifyInternalAssertion(token);
      } catch (assertionErr: any) {
        console.warn(`[AuthMiddleware] Rejected invalid assertion: ${assertionErr?.message}`);
        sendError(res, `Unauthorized: ${assertionErr?.message || 'Invalid assertion'}`, 401);
        return;
      }

      // Find user by subject ID or GitHub ID
      let user = await prisma.user.findFirst({
        where: {
          OR: [
            { id: assertion.sub },
            { githubId: assertion.ghId },
          ],
        },
      });

      if (!user) {
        // Upsert user if first time accessing API via BFF
        user = await prisma.user.upsert({
          where: { githubId: assertion.ghId },
          update: {
            username: assertion.username,
          },
          create: {
            id: assertion.sub,
            githubId: assertion.ghId,
            username: assertion.username,
            accessToken: '', // No plain text token provided in assertion
          },
        });
      }

      // Check if credentials have been revoked (V22)
      if (user.tokenRevokedAt) {
        sendError(res, 'User credentials have been revoked. Please reconnect.', 401);
        return;
      }

      req.user = user;
      next();
      return;
    }

    // 2. Direct GitHub Token (Development / Integration Fallback)
    const octokit = new Octokit({ auth: token });
    const { data: ghUser } = await octokit.rest.users.getAuthenticated();

    if (!ghUser || !ghUser.id) {
      sendError(res, 'Failed to authenticate with GitHub', 401);
      return;
    }

    // Encrypt token before persisting (ADR 0002, V22)
    const encrypted = cryptoService.encryptToken(token);

    const user = await prisma.user.upsert({
      where: { githubId: ghUser.id },
      update: {
        username: ghUser.login,
        email: ghUser.email ?? null,
        avatarUrl: ghUser.avatar_url ?? null,
        accessToken: token, // Legacy field fallback
        encryptedToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenTag: encrypted.tag,
        tokenKeyVersion: encrypted.keyVersion,
        tokenRevokedAt: null, // Clear revocation on fresh login
      },
      create: {
        githubId: ghUser.id,
        username: ghUser.login,
        email: ghUser.email ?? null,
        avatarUrl: ghUser.avatar_url ?? null,
        accessToken: token,
        encryptedToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenTag: encrypted.tag,
        tokenKeyVersion: encrypted.keyVersion,
      },
    });

    if (user.tokenRevokedAt) {
      sendError(res, 'User credentials have been revoked. Please reconnect.', 401);
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Auth Middleware Error:', error instanceof Error ? error.message : 'Unknown error');
    sendError(res, 'Unauthorized: Invalid or expired credentials', 401);
  }
};
