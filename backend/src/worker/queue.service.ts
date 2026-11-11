import { prisma } from '../config/prisma.js';
import { ProcessingRun } from '@prisma/client';

export class QueueService {
  /**
   * Atomically reserves the next available job for processing using PostgreSQL lease locking.
   */
  async reserveNextJob(workerId: string, leaseDurationSeconds: number = 120): Promise<ProcessingRun | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseDurationSeconds * 1000);

    // Find candidate job eligible for processing
    const candidate = await prisma.processingRun.findFirst({
      where: {
        status: { in: ['QUEUED', 'RETRY_WAIT'] },
        availableAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!candidate) {
      return null;
    }

    // Atomic conditional update to secure exclusive lease
    const updateResult = await prisma.processingRun.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        OR: [{ leaseUntil: candidate.leaseUntil }, { leaseUntil: null }],
      },
      data: {
        status: 'RUNNING',
        leaseOwner: workerId,
        leaseUntil,
        attemptCount: { increment: 1 },
      },
    });

    if (updateResult.count === 0) {
      // Lost race to another concurrent worker (V14)
      return null;
    }

    return prisma.processingRun.findUnique({
      where: { id: candidate.id },
      include: {
        repository: {
          include: {
            user: true,
          },
        },
        steps: true,
      },
    });
  }

  /**
   * Heartbeat renewal of lease while worker is actively processing.
   */
  async renewLease(runId: string, workerId: string, extensionSeconds: number = 60): Promise<boolean> {
    const newLeaseUntil = new Date(Date.now() + extensionSeconds * 1000);

    const result = await prisma.processingRun.updateMany({
      where: {
        id: runId,
        leaseOwner: workerId,
        status: 'RUNNING',
      },
      data: {
        leaseUntil: newLeaseUntil,
      },
    });

    return result.count > 0;
  }

  /**
   * Releases lease when job concludes or fails.
   */
  async releaseLease(runId: string, workerId: string): Promise<void> {
    await prisma.processingRun.updateMany({
      where: {
        id: runId,
        leaseOwner: workerId,
      },
      data: {
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }
}

export const queueService = new QueueService();
