import { Router } from 'express';
import { proposalController } from '../controllers/proposal.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/:id', authMiddleware, proposalController.getById);
router.post('/:id/approve', authMiddleware, proposalController.approve);
router.post('/:id/reject', authMiddleware, proposalController.reject);

export { router as proposalRoutes };
