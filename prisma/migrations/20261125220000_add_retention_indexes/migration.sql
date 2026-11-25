-- DropIndex
DROP INDEX "price_snapshots_network_pair_ts_idx";

-- CreateIndex
CREATE INDEX "lending_rates_network_timestamp_idx" ON "lending_rates"("network", "timestamp");

-- CreateIndex
CREATE INDEX "price_snapshots_network_ts_idx" ON "price_snapshots"("network", "ts");

-- CreateIndex
CREATE INDEX "oracle_comparisons_network_timestamp_idx" ON "oracle_comparisons"("network", "timestamp");
