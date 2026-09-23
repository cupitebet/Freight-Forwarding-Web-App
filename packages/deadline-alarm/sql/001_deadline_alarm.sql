-- Skema PostgreSQL untuk modul alarm deadline.

-- Katalog rule per tenant/carrier (override DEFAULT_RULES di kode).
CREATE TABLE IF NOT EXISTS deadline_rule (
  code         TEXT        NOT NULL,
  scope        TEXT        NOT NULL DEFAULT 'default', -- 'default' | 'carrier:MAERSK' | 'customer:123'
  definition   JSONB       NOT NULL,                   -- bentuk = interface DeadlineRule
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (code, scope)
);

-- Idempotensi pengiriman: satu baris per alarm key.
CREATE TABLE IF NOT EXISTS deadline_alarm_sent (
  alarm_key    TEXT        PRIMARY KEY,
  shipment_id  TEXT        NOT NULL,
  rule_code    TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS deadline_alarm_sent_shipment_idx ON deadline_alarm_sent (shipment_id);

-- SentAlarmStore.claim(key):
--   INSERT INTO deadline_alarm_sent (alarm_key, shipment_id, rule_code, kind)
--   VALUES ($1, $2, $3, $4) ON CONFLICT (alarm_key) DO NOTHING RETURNING alarm_key;
--   -> claim berhasil jika ada baris yang dikembalikan.
-- SentAlarmStore.release(key):
--   DELETE FROM deadline_alarm_sent WHERE alarm_key = $1;
