-- Add ClientVersionObservation table for tracking which client versions are
-- hitting the server. Phase 1 of the version-gate rollout: passive observation
-- only, no enforcement. Used to compute v2.4.0 penetration before flipping
-- ENFORCE_CLIENT_VERSION_GATE in Phase 2.
--
-- Sampling: UNIQUE (deviceId, endpoint, dayBucket) — each device records at
-- most once per endpoint per UTC day. Inserts go through Prisma createMany
-- with skipDuplicates so collisions are silently dropped.
--
-- Retention: rows older than 90 days are purged by the hourly cleanup loop in
-- main.ts. The table is statistical, not auditable — losing old rows is OK.

CREATE TABLE "ClientVersionObservation" (
    "id"           SERIAL          PRIMARY KEY,
    "timestamp"    TIMESTAMPTZ(3)  NOT NULL,
    "endpoint"     TEXT            NOT NULL,
    "platform"     TEXT            NOT NULL,
    "version"      TEXT,
    "deviceId"     TEXT            NOT NULL,
    "rawUserAgent" TEXT,
    "dayBucket"    TEXT            NOT NULL
);

-- Dedup index: enforces sampling rate of 1 row per (device, endpoint, UTC day).
CREATE UNIQUE INDEX "ClientVersionObservation_dedup_key"
    ON "ClientVersionObservation" ("deviceId", "endpoint", "dayBucket");

-- Range scans for retention purge (delete WHERE timestamp < cutoff).
CREATE INDEX "ClientVersionObservation_timestamp_idx"
    ON "ClientVersionObservation" ("timestamp");

-- Admin aggregation: GROUP BY platform, version COUNT(DISTINCT deviceId).
CREATE INDEX "ClientVersionObservation_platform_version_idx"
    ON "ClientVersionObservation" ("platform", "version");
