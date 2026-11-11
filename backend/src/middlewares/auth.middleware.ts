import { Request, Response, NextFunction } from 'express';
import { githubService } from '../services/github.service.js';
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
      } catch (assertionErr: unknown) {
        console.warn(`[AuthMiddleware] Rejected invalid assertion: ${(assertionErr instanceof Error ? assertionErr.message : 'Invalid assertion')}`);
        sendError(res, `Unauthorized: ${(assertionErr instanceof Error ? assertionErr.message : 'Invalid assertion') || 'Invalid assertion'}`, 401);
        return;
      }

      // Both claims must identify the same provisioned user. Assertions never create credentials.
      const user = await prisma.user.findFirst({
        where: { id: assertion.sub, githubId: assertion.ghId },
      });
      if (!user) {
        sendError(res, 'Unauthorized: Reconnect your GitHub account', 401);
        return;
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

    // OAuth bootstrap is server-to-server. All other API traffic requires an assertion.
    if (req.originalUrl.split('?')[0] !== '/api/auth/me' || req.method !== 'GET') {
      sendError(res, 'Unauthorized: Internal assertion required', 401);
      return;
    }

    // Validate the OAuth credential with GitHub before provisioning the user.
    const ghUser = await githubService.getAuthenticatedUser(token);

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
        accessToken: '', // Never persist the plaintext OAuth credential
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
        accessToken: '',
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
