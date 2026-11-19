-- Named admin credentials (individual attribution and revocation), an audit log of
-- key operations and admin auth failures, and the admin that minted each API key.
--
-- api_keys.created_by_admin_id is deliberately not a foreign key: 'legacy' marks keys
-- minted with the shared ADMIN_TOKEN, which has no admin_credentials row.
-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "created_by_admin_id" TEXT;

-- CreateTable
CREATE TABLE "admin_credentials" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_key_id" TEXT,
    "admin_id" TEXT,
    "admin_name" TEXT,
    "source_ip" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_credentials_name_key" ON "admin_credentials"("name");

-- CreateIndex
CREATE UNIQUE INDEX "admin_credentials_hash_key" ON "admin_credentials"("hash");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp" DESC);
