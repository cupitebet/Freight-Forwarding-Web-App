-- Model data inti (docs/REVIEW.md bagian 6). Semua waktu timestamptz.

CREATE TABLE job (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               text        NOT NULL UNIQUE,
  direction               text        NOT NULL CHECK (direction IN ('EXPORT', 'IMPORT')),
  mode                    text        NOT NULL CHECK (mode IN ('SEA', 'AIR')),
  roles                   text[]      NOT NULL DEFAULT '{}'
                                      CHECK (roles <@ ARRAY['PPJK', 'NVOCC', 'CARRIER_AGENT']::text[]),
  status                  text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  -- WIB=420, WITA=480, WIT=540
  port_utc_offset_minutes integer     NOT NULL DEFAULT 420 CHECK (port_utc_offset_minutes IN (420, 480, 540)),
  demurrage_free_days     integer     CHECK (demurrage_free_days >= 0),
  detention_free_days     integer     CHECK (detention_free_days >= 0),
  storage_free_days       integer     CHECK (storage_free_days >= 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_active_idx ON job (status) WHERE status = 'ACTIVE';

-- MBL / MAWB. Untuk saat ini satu per job.
CREATE TABLE master_doc (
  job_id            uuid        PRIMARY KEY REFERENCES job (id) ON DELETE CASCADE,
  doc_type          text        NOT NULL CHECK (doc_type IN ('MBL', 'MAWB')),
  number            text,
  carrier_code      text,
  vessel_name       text,
  voyage            text,
  port_of_loading   text        CHECK (port_of_loading ~ '^[A-Z]{2}[A-Z0-9]{3}$'),
  port_of_discharge text        CHECK (port_of_discharge ~ '^[A-Z]{2}[A-Z0-9]{3}$'),
  etd               timestamptz,
  atd               timestamptz,
  eta               timestamptz,
  ata               timestamptz
);

-- HBL / HAWB = pos manifes BC 1.1.
CREATE TABLE house_doc (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  doc_type     text NOT NULL CHECK (doc_type IN ('HBL', 'HAWB')),
  number       text NOT NULL,
  shipper      text,
  consignee    text,
  notify_party text,
  UNIQUE (job_id, number)
);

CREATE TABLE container (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  number      text NOT NULL CHECK (number ~ '^[A-Z]{4}[0-9]{7}$'), -- ISO 6346
  size_type   text,
  seal_number text,
  vgm_kg      numeric(12, 2) CHECK (vgm_kg > 0),
  UNIQUE (job_id, number)
);

CREATE TABLE carrier_cutoff (
  job_id     uuid        NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('SI', 'VGM', 'CY', 'DRAFT_BL')),
  at         timestamptz NOT NULL,
  source     text        NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'EMAIL', 'CARRIER_API')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, kind)
);

CREATE TABLE job_pic (
  job_id  uuid NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  owner   text NOT NULL CHECK (owner IN ('DOCS', 'CUSTOMS', 'OPS', 'FINANCE')),
  contact text NOT NULL, -- mis. "wa:+62812...", "slack:U123"
  PRIMARY KEY (job_id, owner)
);

-- Milestone: satu nilai per event per job (koreksi = update, tercatat di audit_log).
CREATE TABLE milestone (
  job_id      uuid        NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  event       text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  source      text        NOT NULL CHECK (source IN ('MANUAL', 'CEISA', 'DCSA')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, event)
);

-- Riwayat event tracking DCSA mentah (dedup per hash), supaya webhook incremental aman:
-- milestone selalu dihitung ulang dari seluruh riwayat.
CREATE TABLE tracking_event (
  id          bigserial   PRIMARY KEY,
  job_id      uuid        NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  event_hash  text        NOT NULL,
  payload     jsonb       NOT NULL,
  -- clock_timestamp(): beberapa event dalam satu transaksi tetap berurutan sesuai urutan terima.
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, event_hash)
);

CREATE TABLE audit_log (
  id     bigserial   PRIMARY KEY,
  job_id uuid        REFERENCES job (id) ON DELETE SET NULL,
  action text        NOT NULL,
  detail jsonb       NOT NULL DEFAULT '{}',
  actor  text        NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_job_idx ON audit_log (job_id, at);
