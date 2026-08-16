import { Router } from 'express';
import { repositoryController } from '../controllers/repository.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/', authMiddleware, repositoryController.list);
router.post('/toggle', authMiddleware, repositoryController.toggle);

export { router as repositoryRoutes };
