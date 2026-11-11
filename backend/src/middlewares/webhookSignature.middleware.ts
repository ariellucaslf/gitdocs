import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { sendError } from '../utils/response.js';

export const webhookSignatureMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!signature) {
      sendError(res, 'Missing GitHub Webhook signature header', 401);
      return;
    }

    if (!env.GITHUB_WEBHOOK_SECRET) {
      console.warn('⚠️ GITHUB_WEBHOOK_SECRET is not configured.');
      sendError(res, 'Webhook secret not configured on server', 500);
      return;
    }

    // Rejeitar corpo sem bytes originais em vez de reconstruí-lo para verificar assinatura (ADR 0002)
    if (!req.rawBody) {
      sendError(res, 'Raw request payload missing for signature validation', 400);
      return;
    }

    const hmac = crypto.createHmac('sha256', env.GITHUB_WEBHOOK_SECRET);
    const digest = `sha256=${hmac.update(req.rawBody).digest('hex')}`;

    const sigBuffer = Buffer.from(signature);
    const digestBuffer = Buffer.from(digest);

    if (sigBuffer.length !== digestBuffer.length || !crypto.timingSafeEqual(sigBuffer, digestBuffer)) {
      sendError(res, 'Invalid webhook signature', 401);
      return;
    }

    next();
  } catch (error) {
    console.error('❌ Webhook signature validation error:', error);
    sendError(res, 'Internal error during signature validation', 500);
  }
};
