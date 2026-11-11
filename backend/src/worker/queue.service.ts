import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

export type LeasedRun = Prisma.ProcessingRunGetPayload<{ include: { repository: { include: { user: true } }; steps: true } }>;

export class QueueService {
  async reserveNextJob(workerId: string, leaseDurationSeconds = 120): Promise<LeasedRun | null> {
    return prisma.$transaction(async tx => {
      // Expired final attempts must become visible failures, never permanent RUNNING rows.
      await tx.$executeRaw`
        UPDATE "ProcessingRun" SET "status" = 'ERROR', "lastErrorCode" = 'ATTEMPTS_EXHAUSTED',
          "leaseOwner" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW()
        WHERE "status" IN ('RUNNING', 'QUEUED', 'RETRY_WAIT') AND "attemptCount" >= "maxAttempts"
          AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())`;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ProcessingRun"
        WHERE "attemptCount" < "maxAttempts" AND
          (("status" IN ('QUEUED', 'RETRY_WAIT') AND "availableAt" <= NOW())
            OR ("status" = 'RUNNING' AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())))
        ORDER BY "availableAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      return tx.processingRun.update({
        where: { id: rows[0].id },
        data: { status: 'RUNNING', leaseOwner: workerId, leaseUntil: new Date(Date.now() + leaseDurationSeconds * 1000),
          leaseVersion: { increment: 1 }, attemptCount: { increment: 1 } },
        include: { repository: { include: { user: true } }, steps: true },
      });
    });
  }

  async renewLease(runId: string, workerId: string, version: number, extensionSeconds = 120): Promise<boolean> {
    const result = await prisma.processingRun.updateMany({
      where: { id: runId, leaseOwner: workerId, leaseVersion: version, status: 'RUNNING', leaseUntil: { gt: new Date() } },
      data: { leaseUntil: new Date(Date.now() + extensionSeconds * 1000) },
    });
    return result.count === 1;
  }

  async releaseLease(runId: string, workerId: string, version: number): Promise<void> {
    await prisma.processingRun.updateMany({
      where: { id: runId, leaseOwner: workerId, leaseVersion: version },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
export const queueService = new QueueService();
