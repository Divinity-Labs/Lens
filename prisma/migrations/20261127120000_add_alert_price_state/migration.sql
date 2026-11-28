-- #775: pair-level alert evaluation.
--
-- Threshold alerts are checked against the pair's aggregate price, once per
-- (pair, network), instead of each venue's own previous price. The previous
-- value has to outlive the process, or a restart would either lose a crossing
-- that happened meanwhile or invent one by treating the first post-restart
-- price as the previous price.
--
-- One row per (network, pair_key). No foreign key: a pair may be dropped from
-- the watched registry and re-added, and a stale row is harmless — it only
-- supplies the previous price for the next evaluation.
CREATE TABLE "alert_price_states" (
    "pair_key" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "price" DECIMAL(36,18) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_price_states_pkey" PRIMARY KEY ("network","pair_key")
);
