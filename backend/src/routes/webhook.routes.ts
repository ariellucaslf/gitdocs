import { Router } from 'express';
import { webhookController } from '../controllers/webhook.controller.js';
import { webhookSignatureMiddleware } from '../middlewares/webhookSignature.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = Router();

// Public webhook receiver (secured with HMAC GitHub signature)
router.post('/', webhookSignatureMiddleware, webhookController.handle);

// Authenticated user webhook logs
router.get('/logs', authMiddleware, webhookController.listLogs);

export { router as webhookRoutes };
