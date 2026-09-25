-- Klaim alarm sebagai lease: PENDING (sedang dikirim) -> SENT (terkonfirmasi).
-- Klaim PENDING yang lebih tua dari lease boleh diambil ulang, sehingga alarm tidak hilang
-- jika proses mati di antara klaim dan konfirmasi webhook.
ALTER TABLE deadline_alarm_sent
  ADD COLUMN status text NOT NULL DEFAULT 'SENT' CHECK (status IN ('PENDING', 'SENT')),
  ADD COLUMN claimed_at timestamptz NOT NULL DEFAULT now(),
  ALTER COLUMN sent_at DROP NOT NULL,
  ALTER COLUMN sent_at DROP DEFAULT;
-- Baris lama dianggap sudah terkirim (status default 'SENT' di atas); baris baru mulai PENDING.
ALTER TABLE deadline_alarm_sent ALTER COLUMN status SET DEFAULT 'PENDING';
CREATE INDEX deadline_alarm_sent_pending_idx ON deadline_alarm_sent (claimed_at) WHERE status = 'PENDING';
