-- ─────────────────────────────────────────────────────────────────────────────
-- Senda Dispatch Tables
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ─────────────────────────────────────────────────────────────────────────────

-- Active, approved contractors ready to receive dispatch calls
CREATE TABLE IF NOT EXISTS contractors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        UUID REFERENCES contractor_applications(id),
  full_name             TEXT NOT NULL,
  business_name         TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  email                 TEXT NOT NULL,
  trade                 TEXT NOT NULL CHECK (trade IN ('Plumbing', 'HVAC', 'Electrical')),
  zip                   TEXT NOT NULL,
  lat                   DECIMAL(10, 7),
  lng                   DECIMAL(10, 7),
  travel_radius_miles   INTEGER NOT NULL DEFAULT 25,
  is_available          BOOLEAN NOT NULL DEFAULT true,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  consecutive_misses    INTEGER NOT NULL DEFAULT 0,
  last_dispatched_at    TIMESTAMPTZ,
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every inbound homeowner call
CREATE TABLE IF NOT EXISTS call_logs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retell_call_id          TEXT UNIQUE,
  caller_phone            TEXT,
  trade                   TEXT,
  zip                     TEXT,
  issue_description       TEXT,
  outcome                 TEXT CHECK (outcome IN ('connected', 'no_coverage', 'declined_all', 'dropped', 'pending')),
  connected_contractor_id UUID REFERENCES contractors(id),
  duration_seconds        INTEGER,
  transcript              JSONB,
  recording_url           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at                TIMESTAMPTZ
);

-- Each contractor contact attempt within a call
CREATE TABLE IF NOT EXISTS dispatch_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id     UUID NOT NULL REFERENCES call_logs(id) ON DELETE CASCADE,
  contractor_id   UUID NOT NULL REFERENCES contractors(id),
  result          TEXT CHECK (result IN ('accepted', 'declined', 'no_answer', 'pending')),
  distance_miles  DECIMAL(6, 2),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast dispatch queries
CREATE INDEX IF NOT EXISTS idx_contractors_trade_active
  ON contractors(trade) WHERE is_active = true AND is_available = true;

CREATE INDEX IF NOT EXISTS idx_call_logs_created
  ON call_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_call_log
  ON dispatch_events(call_log_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_contractor
  ON dispatch_events(contractor_id);
