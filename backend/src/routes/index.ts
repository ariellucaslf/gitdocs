import { Router } from 'express';
import { authRoutes } from './auth.routes.js';
import { repositoryRoutes } from './repository.routes.js';
import { webhookRoutes } from './webhook.routes.js';

const router = Router();

// Modular Domain Routes Aggregation
router.use('/auth', authRoutes);
router.use('/repositories', repositoryRoutes);
router.use('/webhooks', webhookRoutes);

export { router as mainRouter };
