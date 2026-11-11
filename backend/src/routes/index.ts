import { Router } from 'express';
import { authRoutes } from './auth.routes.js';
import { repositoryRoutes } from './repository.routes.js';
import { webhookRoutes } from './webhook.routes.js';
import { proposalRoutes } from './proposal.routes.js';

const router = Router();

// Modular Domain Routes Aggregation
router.use('/auth', authRoutes);
router.use('/repositories', repositoryRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/proposals', proposalRoutes);

export { router as mainRouter };
