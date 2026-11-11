-- AlterTable
ALTER TABLE "User" ADD COLUMN "encryptedToken" TEXT,
ADD COLUMN "tokenIv" TEXT,
ADD COLUMN "tokenTag" TEXT,
ADD COLUMN "tokenKeyVersion" TEXT,
ADD COLUMN "tokenRevokedAt" TIMESTAMP(3);
