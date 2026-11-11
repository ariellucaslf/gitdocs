-- CreateEnum
CREATE TYPE "ProvisioningState" AS ENUM ('DISABLED', 'PROVISIONING', 'ACTIVE', 'ERROR');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN "desiredActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "provisioningState" "ProvisioningState" NOT NULL DEFAULT 'DISABLED',
ADD COLUMN "lastErrorCode" TEXT;

-- Backfill existing repositories
UPDATE "Repository"
SET "desiredActive" = "isActive",
    "provisioningState" = CASE WHEN "isActive" = true THEN 'ACTIVE'::"ProvisioningState" ELSE 'DISABLED'::"ProvisioningState" END;
