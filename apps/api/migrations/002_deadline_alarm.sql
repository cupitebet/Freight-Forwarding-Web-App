-- Override katalog rule (DEFAULT_RULES di @ff/deadline-alarm). Hanya scope 'default' yang dipakai saat ini.
CREATE TABLE deadline_rule (
  code       text        NOT NULL,
  scope      text        NOT NULL DEFAULT 'default',
  definition jsonb       NOT NULL, -- bentuk = interface DeadlineRule
  active     boolean     NOT NULL DEFAULT TRUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, scope)
);

-- Idempotensi pengiriman alarm: satu baris per alarm key.
CREATE TABLE deadline_alarm_sent (
  alarm_key       text        PRIMARY KEY,
  job_id          uuid        NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  rule_code       text        NOT NULL,
  kind            text        NOT NULL,
  severity        text        NOT NULL,
  escalate        boolean     NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_by text,
  acknowledged_at timestamptz
);
CREATE INDEX deadline_alarm_sent_job_idx ON deadline_alarm_sent (job_id, sent_at);
