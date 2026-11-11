-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING_APPROVAL', 'APPLYING', 'APPLIED', 'REJECTED', 'STALE', 'FAILED');

-- CreateEnum
CREATE TYPE "CommitIntentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'ABANDONED');

-- CreateTable
CREATE TABLE "DocProposal" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseFileHash" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL DEFAULT 'README.md',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "operations" JSONB NOT NULL,
    "evidence" TEXT,
    "previewContent" TEXT,
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "failureReason" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "commitSha" TEXT,
    "commitUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitIntent" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "expectedParentSha" TEXT NOT NULL,
    "expectedContentHash" TEXT NOT NULL,
    "status" "CommitIntentStatus" NOT NULL DEFAULT 'PENDING',
    "appliedCommitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocProposal_repositoryId_prNumber_headSha_idx" ON "DocProposal"("repositoryId", "prNumber", "headSha");

-- CreateIndex
CREATE INDEX "DocProposal_status_idx" ON "DocProposal"("status");

-- CreateIndex
CREATE INDEX "CommitIntent_repositoryId_prNumber_expectedParentSha_idx" ON "CommitIntent"("repositoryId", "prNumber", "expectedParentSha");

-- CreateIndex
CREATE INDEX "CommitIntent_repositoryId_appliedCommitSha_idx" ON "CommitIntent"("repositoryId", "appliedCommitSha");

-- AddForeignKey
ALTER TABLE "DocProposal" ADD CONSTRAINT "DocProposal_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocProposal" ADD CONSTRAINT "DocProposal_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitIntent" ADD CONSTRAINT "CommitIntent_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "DocProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
