-- PayFlow business database (Postgres; PGlite locally when DATABASE_URL is unset).
-- The chain is the source of truth for money: funded/allocated/claimed amounts here are an
-- index of contract events and are re-verified against contract state in reconciliation.
-- Amounts are MUSD wei stored as NUMERIC(78,0) and moved through the app as decimal strings.
-- Addresses are stored lowercase.

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce        TEXT PRIMARY KEY,
  address      TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,           -- random 32-byte hex, stored in httpOnly cookie
  address      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_address_idx ON sessions(address);

CREATE TABLE IF NOT EXISTS organizations (
  id             UUID PRIMARY KEY,
  chain_org_id   NUMERIC(78,0) UNIQUE,      -- OrganizationRegistry id; NULL until the create tx is indexed
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL DEFAULT '',
  logo_url       TEXT,
  owner_wallet   TEXT NOT NULL,
  treasury_wallet TEXT,                     -- business wallet shown on the dashboard
  metadata_hash  TEXT NOT NULL,             -- keccak of canonical {name,slug,description,logo_url}
  default_claim_window_days INTEGER NOT NULL DEFAULT 30,
  create_tx_hash TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | active
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id              UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wallet_address  TEXT NOT NULL,
  email           TEXT,
  display_name    TEXT,
  roles           INTEGER NOT NULL,         -- bitmask: 1 admin, 2 approver, 4 operator (owner = 7)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending (tx not confirmed) | active | removed
  tx_hash         TEXT,
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS recipients (
  id                UUID PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT,
  wallet_address    TEXT NOT NULL,
  external_id       TEXT,                    -- employee / contributor id
  department        TEXT,
  payment_category  TEXT,                    -- salary | contractor | bounty | reward | grant | custom
  payment_frequency TEXT,                    -- one_time | weekly | biweekly | monthly
  default_amount    NUMERIC(78,0),
  status            TEXT NOT NULL DEFAULT 'active', -- active | inactive (excluded from future payroll)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipients_org_idx ON recipients(organization_id);
CREATE INDEX IF NOT EXISTS recipients_wallet_idx ON recipients(wallet_address);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id               UUID PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  chain_run_id     NUMERIC(78,0) UNIQUE,     -- PayrollEscrow run id once created on-chain
  run_ref          TEXT NOT NULL UNIQUE,     -- keccak256(utf8(id)) — bytes32 passed to createRun
  name             TEXT NOT NULL,
  payment_category TEXT NOT NULL,
  frequency        TEXT NOT NULL DEFAULT 'one_time', -- one_time | monthly
  schedule_id      UUID,
  total_amount     NUMERIC(78,0) NOT NULL DEFAULT 0,
  recipient_count  INTEGER NOT NULL DEFAULT 0,
  token_address    TEXT NOT NULL,
  scheduled_at     TIMESTAMPTZ,              -- intended payment date
  claim_window_days INTEGER NOT NULL DEFAULT 30,
  -- draft | onchain_draft | pending_approval | approved | funded | published
  -- | partially_claimed | completed | cancelled | expired   (see lib/api-types.ts RunStatus)
  status           TEXT NOT NULL DEFAULT 'draft',
  payments_hash    TEXT,                     -- expected on-chain commitment (lib/chain/commitment.ts)
  merkle_root      TEXT,                     -- reserved; on-chain records are used in v1
  funded_amount    NUMERIC(78,0) NOT NULL DEFAULT 0,
  claimed_amount   NUMERIC(78,0) NOT NULL DEFAULT 0,
  refunded_amount  NUMERIC(78,0) NOT NULL DEFAULT 0,
  claimed_count    INTEGER NOT NULL DEFAULT 0,
  claim_deadline   TIMESTAMPTZ,
  funder_wallet    TEXT,
  create_tx_hash   TEXT,
  fund_tx_hash     TEXT,
  publish_tx_hash  TEXT,
  created_by       TEXT NOT NULL,
  approved_by      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_runs_org_idx ON payroll_runs(organization_id);

CREATE TABLE IF NOT EXISTS payroll_items (
  id                UUID PRIMARY KEY,
  payroll_run_id    UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  recipient_id      UUID REFERENCES recipients(id) ON DELETE SET NULL,
  item_index        INTEGER NOT NULL,        -- on-chain payment index within the run
  name              TEXT NOT NULL,
  email             TEXT,
  department        TEXT,
  recipient_address TEXT NOT NULL,
  amount            NUMERIC(78,0) NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  payment_id        NUMERIC(78,0) UNIQUE,    -- (chain_run_id << 32) | item_index once allocated
  -- pending | allocated | claimed | cancelled | expired
  claim_status      TEXT NOT NULL DEFAULT 'pending',
  allocate_tx_hash  TEXT,
  transaction_hash  TEXT,                    -- claim tx
  claimed_at        TIMESTAMPTZ,
  UNIQUE (payroll_run_id, item_index)
);
CREATE INDEX IF NOT EXISTS payroll_items_wallet_idx ON payroll_items(recipient_address);

CREATE TABLE IF NOT EXISTS payment_claims (
  id               UUID PRIMARY KEY,
  payroll_run_id   UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payment_id       NUMERIC(78,0) NOT NULL UNIQUE,
  recipient_address TEXT NOT NULL,
  amount           NUMERIC(78,0) NOT NULL,
  claimed_at       TIMESTAMPTZ NOT NULL,
  transaction_hash TEXT NOT NULL,
  block_number     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_approvals (
  id               UUID PRIMARY KEY,
  payroll_run_id   UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  approver_wallet  TEXT NOT NULL,
  status           TEXT NOT NULL,            -- approved | rejected
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rejection_reason TEXT,
  tx_hash          TEXT
);

CREATE TABLE IF NOT EXISTS payment_manifests (
  id               UUID PRIMARY KEY,
  payroll_run_id   UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  manifest_hash    TEXT NOT NULL,            -- sha256 of canonical manifest JSON
  payments_hash    TEXT,                     -- on-chain commitment it maps to
  merkle_root      TEXT,
  total_amount     NUMERIC(78,0) NOT NULL,
  recipient_count  INTEGER NOT NULL,
  manifest_json    JSONB NOT NULL,           -- [{index, recipient, amount}] — no names/emails
  storage_location TEXT NOT NULL DEFAULT 'db',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_schedules (
  id               UUID PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  payment_category TEXT NOT NULL,
  frequency        TEXT NOT NULL,            -- weekly | biweekly | monthly
  day_of_month     INTEGER,                  -- monthly: 1..28
  weekday          INTEGER,                  -- weekly/biweekly: 0..6 (Sun=0)
  items_json       JSONB NOT NULL,           -- [{recipient_id, amount, description}]
  next_run_at      TIMESTAMPTZ NOT NULL,
  last_generated_at TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id               UUID PRIMARY KEY,
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,
  wallet_address   TEXT,                     -- in-app recipient
  email            TEXT,                     -- email recipient (optional)
  kind             TEXT NOT NULL,            -- see lib/api-types.ts NotificationKind
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  link             TEXT,
  dedupe_key       TEXT UNIQUE,              -- makes generation idempotent
  read_at          TIMESTAMPTZ,
  email_status     TEXT NOT NULL DEFAULT 'none', -- none | queued | sent | failed | skipped
  email_error      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_wallet_idx ON notifications(wallet_address);

CREATE TABLE IF NOT EXISTS indexed_events (
  chain_id         INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_name       TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  block_number     BIGINT NOT NULL,
  log_index        INTEGER NOT NULL,
  args_json        JSONB NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  name             TEXT PRIMARY KEY,
  last_block       BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id               UUID PRIMARY KEY,
  organization_id  UUID,
  actor_wallet     TEXT NOT NULL,
  action           TEXT NOT NULL,
  resource_id      TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_org_idx ON audit_logs(organization_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key              TEXT PRIMARY KEY,
  window_start     TIMESTAMPTZ NOT NULL,
  count            INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Audit remediation (2026-11-09). Additive and idempotent: safe to re-run on existing databases.
-- ---------------------------------------------------------------------------------------------

-- Reviewed items are immutable once the run leaves the off-chain draft. What the chain actually
-- allocated is stored next to them; any difference blocks the run (PayrollRun.chainMismatch).
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS chain_recipient_address TEXT;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS chain_amount NUMERIC(78,0);
-- false for an on-chain payment that has no reviewed draft item (always a mismatch).
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS reviewed BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS payroll_items_run_idx ON payroll_items(payroll_run_id, item_index);

-- From RunSubmitted / getRun; used when RunApproved is indexed before RunSubmitted.
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approvals_required INTEGER;
CREATE INDEX IF NOT EXISTS payroll_runs_org_created_idx ON payroll_runs(organization_id, created_at DESC);

-- Contact email of the creator (copied onto the owner's member row); last metadata hash set on-chain.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS chain_metadata_hash TEXT;
CREATE INDEX IF NOT EXISTS organizations_owner_idx ON organizations(owner_wallet);

-- Email outbox retries: queued → sending (leased) → sent | queued (retry with backoff) | failed.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_next_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS notifications_email_idx ON notifications(email_status, email_next_attempt_at);

CREATE INDEX IF NOT EXISTS indexed_events_run_idx ON indexed_events(event_name, ((args_json->>'runId')));
-- 2026-11-12: the claim window the chain recorded; the reviewed claim_window_days is never overwritten.
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS chain_claim_window_seconds INTEGER;
