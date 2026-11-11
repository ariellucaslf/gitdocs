import { Router } from 'express';
import { repositoryController } from '../controllers/repository.controller.js';
import { proposalController } from '../controllers/proposal.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/', authMiddleware, repositoryController.list);
router.post('/toggle', authMiddleware, repositoryController.toggle);
router.get('/:repositoryId/proposals', authMiddleware, proposalController.list);

export { router as repositoryRoutes };
