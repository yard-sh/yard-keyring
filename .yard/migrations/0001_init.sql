-- Keyring schema. Every statement is idempotent: migration files are not
-- transactional, so a mid-file failure leaves earlier statements applied and
-- the file unrecorded in _yard_migrations, which re-runs it from the top on
-- the next deploy. IF NOT EXISTS makes that re-run harmless.
--
-- Rent is not here. Monthly rent items are computed from a lease's terms
-- every time a ledger is read, so nothing has to run on the 1st of the month
-- and a GET never writes. Only what people do is stored: one-off charges,
-- payments, requests and their threads, announcements.
--
-- Comments on a request reach this database late on purpose: each property's
-- room buffers them and writes one batch per burst from its alarm.
--
-- Times are milliseconds since the epoch, written by the service. Calendar
-- dates (lease start and end, due dates) are UTC midnight of that day.
--
-- property_id is on every table, so deleting a property is one batch of
-- DELETE ... WHERE property_id = ?, and property-wide reads need no joins.

-- One row per person who has opened the app.
CREATE TABLE IF NOT EXISTS users (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  email   TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL
);

-- The landlord is landlord_id and nothing else: landlords are never listed in
-- lease_tenants. phone, emergency and hours are the contact card tenants see.
CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  emergency   TEXT NOT NULL DEFAULT '',
  hours       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_properties_landlord ON properties (landlord_id, created_at);

-- The column's collation makes the unique index case-insensitive: "4b" is "4B".
CREATE TABLE IF NOT EXISTS units (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  number      TEXT NOT NULL COLLATE NOCASE,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_units_number ON units (property_id, number);

-- ends_at is the last day of the term: optional, and it caps rent. ended_at is
-- when the landlord ended the lease: NULL means running, which is what holds
-- the unit and what gives its tenants access. The partial unique index is the
-- backstop for "one running lease per unit".
CREATE TABLE IF NOT EXISTS leases (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  unit_id     TEXT NOT NULL,
  due_day     INTEGER NOT NULL,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER,
  ended_at    INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_running ON leases (unit_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leases_property ON leases (property_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_leases_unit ON leases (unit_id, created_at);

-- Rent history. from_month counts months as year * 12 + month (0-11), UTC.
-- The rent for month M is the row with the largest from_month <= M. A change
-- only ever adds a row for a future month, so an item a tenant has already
-- seen never changes its amount.
CREATE TABLE IF NOT EXISTS rent_steps (
  lease_id    TEXT NOT NULL,
  from_month  INTEGER NOT NULL,
  rent_cents  INTEGER NOT NULL,
  property_id TEXT NOT NULL,
  PRIMARY KEY (lease_id, from_month)
);

CREATE INDEX IF NOT EXISTS idx_rent_steps_property ON rent_steps (property_id);

-- Everyone who lives under a lease. Roommates share its charges and see each
-- other's payments; a new lease on the same unit starts with nobody.
CREATE TABLE IF NOT EXISTS lease_tenants (
  lease_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  property_id TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (lease_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenants_user ON lease_tenants (user_id, property_id);

CREATE INDEX IF NOT EXISTS idx_tenants_property ON lease_tenants (property_id);

-- A single-use link into one lease. email is only a label (who the landlord
-- meant it for); whoever signs in with the link first claims it, which sets
-- claimed_by exactly once. Revoking deletes the row.
CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL,
  lease_id    TEXT NOT NULL,
  property_id TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  claimed_by  TEXT,
  claimed_at  INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token ON invites (token);

CREATE INDEX IF NOT EXISTS idx_invites_lease ON invites (lease_id);

CREATE INDEX IF NOT EXISTS idx_invites_property ON invites (property_id);

-- One-off charges only: deposit, late_fee, utilities, other. Voiding one
-- deletes it, and only while nothing has paid it.
CREATE TABLE IF NOT EXISTS charges (
  id           TEXT PRIMARY KEY,
  lease_id     TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  due_at       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_charges_lease ON charges (lease_id, due_at);

CREATE INDEX IF NOT EXISTS idx_charges_property ON charges (property_id);

-- One row per settled item: item_ref is 'rent:2026-10' or 'charge:<id>'. The
-- label and amount are copied when it is paid, so a receipt never changes.
-- The unique index is what makes paying one item twice impossible, even when
-- two roommates press Pay at the same moment. Declined cards write nothing.
-- method is card (simulated), cash or check (recorded by the landlord).
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  lease_id     TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  item_ref     TEXT NOT NULL,
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method       TEXT NOT NULL,
  card_last4   TEXT NOT NULL DEFAULT '',
  confirmation TEXT NOT NULL,
  paid_by      TEXT NOT NULL,
  paid_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_item ON payments (lease_id, item_ref);

CREATE INDEX IF NOT EXISTS idx_payments_property ON payments (property_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_payments_confirmation ON payments (lease_id, confirmation);

CREATE TABLE IF NOT EXISTS announcements (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  posted_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_property ON announcements (property_id, pinned, posted_at);

-- Maintenance requests ("tickets" in code; the app says Requests). status is
-- submitted, acknowledged, in_progress or resolved; only the landlord moves
-- it. comment_count and updated_at are refreshed by the room's flush.
CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL,
  lease_id      TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  category      TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  entry_ok      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'submitted',
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_property ON tickets (property_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_tickets_lease ON tickets (lease_id, created_at);

-- A request's thread: kind 'status' rows (written by the handler in the same
-- batch as the status change) and kind 'comment' rows (written by the
-- room's flush). Comment ids come from the room, so a retried flush
-- inserts nothing twice. Author names are joined from users when read, so a
-- rename shows up everywhere.
CREATE TABLE IF NOT EXISTS ticket_events (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  property_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_events ON ticket_events (ticket_id, at);

CREATE INDEX IF NOT EXISTS idx_ticket_events_property ON ticket_events (property_id);
