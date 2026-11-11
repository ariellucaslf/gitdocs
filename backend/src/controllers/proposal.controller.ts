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

      const proposals = await docProposalService.listProposals(repositoryId, prNumber);
      sendSuccess(res, proposals);
    } catch (error: unknown) {
      console.error('Error listing proposals:', error);
      const message = error instanceof Error ? error.message : 'Failed to list proposals';
      sendError(res, message, 500);
    }
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      if (!id) {
        sendError(res, 'Proposal ID is required', 400);
        return;
      }

      const proposal = await docProposalService.getProposal(id);

      if (!proposal) {
        sendError(res, 'Proposal not found', 404);
        return;
      }

      sendSuccess(res, proposal);
    } catch (error: unknown) {
      console.error('Error fetching proposal:', error);
      const message = error instanceof Error ? error.message : 'Failed to fetch proposal';
      sendError(res, message, 500);
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
      console.error('Error approving proposal:', error);
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
      console.error('Error rejecting proposal:', error);
      const statusCode = error.statusCode || 500;
      const message = error.message || 'Failed to reject proposal';
      sendError(res, message, statusCode);
    }
  };
}

export const proposalController = new ProposalController();
