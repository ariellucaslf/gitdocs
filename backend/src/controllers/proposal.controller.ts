import { logSafeError } from '../utils/logger.js';
import { Request, Response } from 'express';
import { docProposalService } from '../services/docProposal.service.js';
import { sendSuccess, sendError } from '../utils/response.js';

export class ProposalController {
  list = async (req: Request, res: Response): Promise<void> => {
    try {
      const { repositoryId } = req.params;
      const prNumber = req.query.prNumber ? Number(req.query.prNumber) : undefined;

      if (!repositoryId) {
        sendError(res, 'Repository ID is required', 400);
        return;
      }

      if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) { sendError(res, 'Invalid PR number', 400); return; }
      const proposals = await docProposalService.listProposals(repositoryId, req.user!.id, prNumber);
      sendSuccess(res, proposals);
    } catch (error: unknown) {
      logSafeError('Error listing proposals:', error);
      const message = error && typeof error === 'object' && 'statusCode' in error && error instanceof Error ? error.message : 'Failed to list proposals';
      sendError(res, message, error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500);
    }
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      if (!id) {
        sendError(res, 'Proposal ID is required', 400);
        return;
      }

      const proposal = await docProposalService.getProposal(id, req.user!.id);

      if (!proposal) {
        sendError(res, 'Proposal not found', 404);
        return;
      }

      sendSuccess(res, proposal);
    } catch (error: unknown) {
      logSafeError('Error fetching proposal:', error);
      const message = error && typeof error === 'object' && 'statusCode' in error && error instanceof Error ? error.message : 'Failed to fetch proposal';
      sendError(res, message, error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500);
    }
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      if (!id) {
        sendError(res, 'Proposal ID is required', 400);
        return;
      }

      if (!userId) {
        sendError(res, 'Authentication required', 401);
        return;
      }

      const result = await docProposalService.approveProposal(id, userId);
      sendSuccess(res, result);
    } catch (error: any) {
      logSafeError('Error approving proposal:', error);
      const statusCode = error.statusCode || 500;
      const message = error.message || 'Failed to approve proposal';
      sendError(res, message, statusCode);
    }
  };

  reject = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      const { reason } = req.body || {};
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
        sendError(res, 'Invalid rejection reason', 400); return;
      }

      if (!id) {
        sendError(res, 'Proposal ID is required', 400);
        return;
      }

      if (!userId) {
        sendError(res, 'Authentication required', 401);
        return;
      }

      const updated = await docProposalService.rejectProposal(id, userId, reason);
      sendSuccess(res, updated);
    } catch (error: any) {
      logSafeError('Error rejecting proposal:', error);
      const statusCode = error.statusCode || 500;
      const message = error.message || 'Failed to reject proposal';
      sendError(res, message, statusCode);
    }
  };
}

export const proposalController = new ProposalController();
