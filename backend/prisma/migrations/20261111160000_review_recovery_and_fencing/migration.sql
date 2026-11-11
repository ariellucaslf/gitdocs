ALTER TABLE "Repository" ADD COLUMN "provisioningLeaseUntil" TIMESTAMP(3),
ADD COLUMN "provisioningVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProcessingRun" ADD COLUMN "leaseVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "analysisResult" JSONB,
ADD COLUMN "commentBody" TEXT;
ALTER TABLE "DocProposal" ADD COLUMN "runId" TEXT;
CREATE UNIQUE INDEX "DocProposal_runId_key" ON "DocProposal"("runId");
ALTER TABLE "CommitIntent" ADD COLUMN "preparedCommitSha" TEXT;
CREATE INDEX "ProcessingRun_status_leaseUntil_idx" ON "ProcessingRun"("status", "leaseUntil");

-- Legacy active flags were not proof that a webhook existed.
UPDATE "Repository" SET "isActive" = false, "provisioningState" = 'ERROR',
"lastErrorCode" = 'WEBHOOK_RECONCILIATION_REQUIRED'
WHERE "desiredActive" = true AND "webhookId" IS NULL;

-- The old in-process jobs cannot be replayed safely without their payload.
UPDATE "WebhookLog" SET "status" = 'ERROR', "errorMessage" = 'LEGACY_PROCESSING_INTERRUPTED'
WHERE "status" = 'PENDING' AND "id" NOT IN (SELECT "id" FROM "ProcessingRun");
