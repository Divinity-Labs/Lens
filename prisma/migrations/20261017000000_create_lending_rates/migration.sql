-- CreateTable
CREATE TABLE "lending_rates" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "source" TEXT NOT NULL DEFAULT 'blend',
    "pool_id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "asset_address" TEXT,
    "supply_apy" DECIMAL(36,18) NOT NULL,
    "borrow_apy" DECIMAL(36,18) NOT NULL,
    "supply_apr" DECIMAL(36,18),
    "borrow_apr" DECIMAL(36,18),
    "utilization" DECIMAL(36,18) NOT NULL,
    "total_supply" DECIMAL(36,7),
    "total_borrowed" DECIMAL(36,7),
    "reserves" DECIMAL(36,7),
    "ledger" INTEGER NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lending_rates_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateIndex
CREATE INDEX "lending_rates_network_pool_id_timestamp_idx" ON "lending_rates"("network", "pool_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "lending_rates_network_asset_timestamp_idx" ON "lending_rates"("network", "asset", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "lending_rates_network_pool_id_asset_timestamp_idx" ON "lending_rates"("network", "pool_id", "asset", "timestamp" DESC);
