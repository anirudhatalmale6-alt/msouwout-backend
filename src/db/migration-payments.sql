-- Migration: payments
--
-- Stage 1 of the payment plan (msouwout.com/eta/pay).
--
-- Deliberately NOT shaped as "ride payments". Jeffery's instruction on
-- 16 Sep 2026 was that the payment flow belongs to the HaitiBiznis ecosystem
-- rather than to MsouWout, so this table records a payment against a SUBJECT
-- (ride / order / ticket) instead of hard-wiring a ride id. The same shape can
-- then be mirrored into the central HaitiBiznis ledger in Stage 2 without
-- rewriting anything here, and a second service can adopt it as-is.
--
-- Why a row at all, when the gateway already knows: the gateway has NO webhook.
-- The only way to learn a payment succeeded is to ask it, which means something
-- has to remember what we are waiting for. That is this table.

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Who took the money. 'solutionip' today; Stripe plugs in beside it
    -- without a schema change.
    provider VARCHAR(40) NOT NULL DEFAULT 'solutionip',
    -- The reference WE generate and send to the provider. Unique because it is
    -- what we look a payment up by, from both sides.
    reference_id VARCHAR(80) NOT NULL UNIQUE,
    -- Whatever the provider calls it. Null until they tell us.
    provider_ref VARCHAR(120),

    -- What was paid for. Not a foreign key on purpose: a ticket or a shop
    -- order lives in another database entirely.
    subject_type VARCHAR(20) NOT NULL DEFAULT 'ride',
    subject_id UUID,

    -- Money is stored in the smallest sensible unit for the currency and never
    -- as a float. HTG amounts here are whole gourdes.
    amount INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'HTG',
    method VARCHAR(20) NOT NULL,

    -- pending  - created, passenger sent to the gateway, outcome unknown
    -- paid     - the PROVIDER confirmed it. Never set from the browser.
    -- failed   - the provider said no
    -- expired  - we stopped asking (see attempts below)
    -- refunded - Stage 3
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    payment_url TEXT,
    payer_phone VARCHAR(50),

    -- Polling bookkeeping. A passenger who closes the app mid-payment is the
    -- normal case, not the edge case, so the server keeps asking on its own.
    attempts INTEGER NOT NULL DEFAULT 0,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    paid_at TIMESTAMP WITH TIME ZONE,

    -- The provider's own last answer, kept verbatim. When a passenger says they
    -- paid and we say they did not, this is the only thing that settles it.
    last_response JSONB,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_subject  ON payments (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments (status);
-- The poller's query: everything still pending, oldest checked first.
CREATE INDEX IF NOT EXISTS idx_payments_pending  ON payments (status, last_checked_at);

-- The ride's own view of it. payment_method already exists and keeps its
-- meaning ('cash' by default); these two say whether money actually arrived.
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid';
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id);
