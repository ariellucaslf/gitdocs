import { Request, Response } from 'express';
import { sendSuccess, sendError } from '../utils/response.js';

export class AuthController {
  getMe = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        sendError(res, 'User not authenticated', 401);
        return;
      }

      sendSuccess(res, {
        id: req.user.id,
        githubId: req.user.githubId,
        username: req.user.username,
        email: req.user.email,
        avatarUrl: req.user.avatarUrl,
        createdAt: req.user.createdAt,
      });
    } catch (error) {
      console.error('❌ AuthController.getMe error:', error);
      sendError(res, 'Failed to fetch user profile', 500);
    }
  };
}

export const authController = new AuthController();
