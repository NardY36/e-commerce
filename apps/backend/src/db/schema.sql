-- E-Commerce schema. Safe to run repeatedly (idempotent DDL).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ─── Orders ────────────────────────────────────────────────────────────────
-- A merchant order. The state machine is enforced in application code
-- (orders/order.types.ts) but we keep the column constrained for safety.
CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number     integer NOT NULL UNIQUE,
  merchant_chat_id text,
  item_name        text    NOT NULL,
  quantity         integer NOT NULL DEFAULT 1,
  amount_etb       numeric(12,2) NOT NULL,
  courier_eta_min  integer,
  state            text NOT NULL DEFAULT 'PENDING'
                   CHECK (state IN ('PENDING','READY_FOR_PICKUP','PICKED_UP','DELIVERED','CANCELLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ─── Payments ──────────────────────────────────────────────────────────────
-- One row per *payment intent*. The UNIQUE idempotency_key is the single most
-- important constraint in this system: it makes "charge this order" safe to
-- retry any number of times without ever creating a second charge.
CREATE TABLE IF NOT EXISTS payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  order_id         uuid REFERENCES orders(id),
  amount_etb       numeric(12,2) NOT NULL,
  customer_phone   text NOT NULL,
  -- PENDING          -> accepted, queued, not yet sent to Telebirr
  -- PROCESSING       -> worker is calling Telebirr right now
  -- PENDING_VERIFY   -> Telebirr timed out; outcome unknown, awaiting webhook/poll
  -- SUCCESS / FAILED -> terminal
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','PROCESSING','PENDING_VERIFY','SUCCESS','FAILED')),
  telebirr_ref     text,          -- gateway-side transaction id once known
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ─── Courier pings ─────────────────────────────────────────────────────────
-- Location breadcrumbs + delivery events uploaded (often in batches) by the
-- courier Flutter app after passing through a low-connectivity zone. client_ping_id
-- is generated on the device so a replayed batch upload is deduped here too —
-- the same offline-safety idea as payments, applied to telemetry.
CREATE TABLE IF NOT EXISTS courier_pings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ping_id text NOT NULL UNIQUE,
  courier_id     text NOT NULL,
  order_id       uuid REFERENCES orders(id),
  kind           text NOT NULL DEFAULT 'LOCATION'
                 CHECK (kind IN ('LOCATION','DELIVERY_CONFIRMED')),
  location       geography(Point, 4326),
  recorded_at    timestamptz NOT NULL, -- when it happened on the device
  synced_at      timestamptz NOT NULL DEFAULT now() -- when the server received it
);

CREATE INDEX IF NOT EXISTS idx_courier_pings_order ON courier_pings(order_id);
CREATE INDEX IF NOT EXISTS idx_courier_pings_geo   ON courier_pings USING GIST (location);
