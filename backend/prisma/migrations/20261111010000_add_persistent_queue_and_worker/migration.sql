-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCESS', 'PARTIAL_SUCCESS', 'ERROR', 'SKIPPED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'SKIPPED', 'ERROR');

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "headSha" TEXT,
    "payloadDigest" TEXT NOT NULL,
    "admissionStatus" TEXT NOT NULL,
    "admissionReason" TEXT,
    "processingRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingRun" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prTitle" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseRef" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "rawDiffSize" INTEGER,
    "commentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "externalId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_deliveryId_key" ON "WebhookDelivery"("deliveryId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_repositoryId_createdAt_idx" ON "WebhookDelivery"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessingRun_status_availableAt_idx" ON "ProcessingRun"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingRun_repositoryId_prNumber_headSha_key" ON "ProcessingRun"("repositoryId", "prNumber", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingStep_runId_stepName_key" ON "ProcessingStep"("runId", "stepName");

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "ProcessingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingRun" ADD CONSTRAINT "ProcessingRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingStep" ADD CONSTRAINT "ProcessingStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProcessingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
