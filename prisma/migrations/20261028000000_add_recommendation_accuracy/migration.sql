-- CreateTable
CREATE TABLE "recommendation_quotes" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "pair_key" TEXT NOT NULL,
    "asset_a" TEXT NOT NULL,
    "asset_b" TEXT NOT NULL,
    "recommended_venue" TEXT NOT NULL,
    "predicted_price" DECIMAL(36,18) NOT NULL,
    "predicted_slippage" DECIMAL(10,6) NOT NULL,
    "estimated_output" DECIMAL(36,18),
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_quotes_pkey" PRIMARY KEY ("network","id")
);

-- CreateTable
CREATE TABLE "realised_trade_executions" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "quote_id" TEXT,
    "pair_key" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "realised_price" DECIMAL(36,18) NOT NULL,
    "realised_slippage" DECIMAL(10,6),
    "tx_hash" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realised_trade_executions_pkey" PRIMARY KEY ("network","id")
);

-- CreateIndex
CREATE INDEX "recommendation_quotes_network_pair_key_timestamp_idx" ON "recommendation_quotes"("network", "pair_key", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "recommendation_quotes_network_recommended_venue_pair_key_ti_idx" ON "recommendation_quotes"("network", "recommended_venue", "pair_key", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "realised_trade_executions_network_pair_key_venue_timestamp_idx" ON "realised_trade_executions"("network", "pair_key", "venue", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "realised_trade_executions_network_quote_id_idx" ON "realised_trade_executions"("network", "quote_id");

-- AddForeignKey
ALTER TABLE "realised_trade_executions" ADD CONSTRAINT "realised_trade_executions_network_quote_id_fkey" FOREIGN KEY ("network", "quote_id") REFERENCES "recommendation_quotes"("network", "id") ON DELETE CASCADE ON UPDATE CASCADE;
