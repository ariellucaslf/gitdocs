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

    // Use rawBody buffer if available, otherwise serialize req.body
    const payload = req.rawBody ? req.rawBody : Buffer.from(JSON.stringify(req.body));
    const hmac = crypto.createHmac('sha256', env.GITHUB_WEBHOOK_SECRET);
    const digest = `sha256=${hmac.update(payload).digest('hex')}`;

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
