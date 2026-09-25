/**
 * Model data untuk modul alarm cut-off / deadline.
 *
 * Semua waktu disimpan sebagai string ISO 8601 LENGKAP dengan offset
 * (mis. "2026-09-25T17:00:00+07:00") supaya tidak ada ambiguitas WIB/WITA/WIT.
 */

export type Direction = 'EXPORT' | 'IMPORT';
export type TransportMode = 'SEA' | 'AIR';

/** Peran perusahaan pada shipment ini — menentukan kewajiban mana yang berlaku. */
export type CompanyRole =
  | 'PPJK' // pengurus dokumen kepabeanan (PIB/PEB)
  | 'NVOCC' // penerbit house B/L -> wajib pos manifes (BC 1.1) level house
  | 'CARRIER_AGENT'; // agen pelayaran -> RKSP & master manifes

/** Cut-off yang diumumkan pelayaran / terminal di booking confirmation. */
export type CarrierCutoff =
  | 'SI' // Shipping Instruction / doc closing
  | 'VGM' // Verified Gross Mass (SOLAS)
  | 'CY' // Container Yard closing (batas gate-in full container)
  | 'DRAFT_BL'; // batas konfirmasi draft B/L

/** Event penyelesaian — diisi oleh Core App saat pekerjaan selesai. */
export type MilestoneEvent =
  | 'SI_SUBMITTED'
  | 'VGM_SUBMITTED'
  | 'DRAFT_BL_APPROVED'
  | 'NPE_ISSUED' // PEB mendapat NPE
  | 'PEB_BL_UPDATED' // nomor/tanggal MBL/HBL dilengkapi di PEB setelah kapal berangkat
  | 'CONTAINER_GATE_IN'
  | 'OUTWARD_MANIFEST_SUBMITTED'
  | 'RKSP_SUBMITTED'
  | 'INWARD_MANIFEST_SUBMITTED'
  | 'HOUSE_BL_RECONCILED' // pos house B/L sudah terekonsiliasi dengan master B/L di CEISA
  | 'PIB_SUBMITTED'
  | 'SPPB_ISSUED'
  | 'RED_LANE_ASSIGNED' // jalur merah
  | 'PHYSICAL_INSPECTION_DONE'
  | 'CONTAINER_DISCHARGED'
  | 'CONTAINER_GATE_OUT' // full keluar terminal
  | 'EMPTY_RETURNED'; // empty kembali ke depo

export type Owner = 'DOCS' | 'CUSTOMS' | 'OPS' | 'FINANCE';

export interface Shipment {
  id: string;
  /** Nomor job internal, tampil di notifikasi. */
  reference: string;
  direction: Direction;
  mode: TransportMode;
  roles: CompanyRole[];
  vesselName?: string;
  voyage?: string;
  /** UN/LOCODE, mis. "IDJKT". Dipakai untuk mencocokkan event tracking (abaikan transshipment). */
  portOfLoading?: string;
  portOfDischarge?: string;
  /** Nomor container, mis. ["MSCU7349821"]. */
  containers?: string[];
  /** Estimasi & aktual jadwal sarana pengangkut. Aktual selalu diutamakan. */
  etd?: string;
  atd?: string;
  eta?: string;
  ata?: string;
  /** Offset zona waktu pelabuhan terkait, menit. WIB=420, WITA=480, WIT=540. Default WIB. */
  portUtcOffsetMinutes?: number;
  carrierCutoffs?: Partial<Record<CarrierCutoff, string>>;
  /** Free time dari kontrak pelayaran / terminal, dalam hari kalender. */
  freeTime?: {
    demurrageDays?: number;
    detentionDays?: number;
    storageDays?: number;
  };
  /** Waktu terjadinya milestone. */
  events?: Partial<Record<MilestoneEvent, string>>;
  /** PIC per fungsi — dipakai notifier untuk routing (nomor WA, user id, dsb). */
  pic?: Partial<Record<Owner, string>>;
}

/** Titik acuan perhitungan deadline. */
export type Anchor =
  | { kind: 'CARRIER_CUTOFF'; cutoff: CarrierCutoff }
  | { kind: 'DEPARTURE'; offsetHours: number } // ATD, fallback ETD
  | { kind: 'ARRIVAL'; offsetHours: number } // ATA, fallback ETA
  /**
   * Relatif terhadap kedatangan, dengan offset berbeda menurut lama pelayaran (ETD/ATD → ETA/ATA).
   * Contoh inward manifest laut: pelayaran >= 24 jam → 24 jam sebelum tiba; < 24 jam → sebelum tiba.
   * Jika waktu berangkat belum diketahui, dipakai offset pelayaran panjang (lebih awal = lebih aman)
   * dan deadline ditandai estimasi.
   */
  | { kind: 'ARRIVAL_BY_VOYAGE'; thresholdHours: number; longVoyageOffsetHours: number; shortVoyageOffsetHours: number }
  | { kind: 'EVENT'; event: MilestoneEvent; offsetHours: number }
  /**
   * Free time: berakhir pukul 23:59:59 waktu pelabuhan pada hari ke-N,
   * dihitung sejak tanggal event (hari event = hari ke-1).
   */
  | { kind: 'FREE_TIME'; from: MilestoneEvent | 'ARRIVAL'; days: keyof NonNullable<Shipment['freeTime']> };

export type Category = 'PELAYARAN' | 'BEA_CUKAI' | 'TERMINAL' | 'BIAYA';

export interface DeadlineRule {
  code: string;
  title: string;
  category: Category;
  owner: Owner;
  directions: Direction[];
  modes: TransportMode[];
  /** Jika diisi, rule hanya berlaku bila perusahaan memegang salah satu peran ini. */
  roles?: CompanyRole[];
  anchor: Anchor;
  /** Dipakai jika anchor utama belum ada datanya; hasilnya ditandai `estimated`. */
  fallback?: Anchor;
  doneWhen: MilestoneEvent;
  /** Jam sebelum deadline untuk mengirim pengingat, mis. [72, 24, 6, 2]. */
  remindBeforeHours: number[];
  /** Ulangi alarm terlambat tiap N jam (default 4), maksimal `maxOverdueAlarms` kali. */
  overdueRepeatHours?: number;
  maxOverdueAlarms?: number;
  /** Dasar aturan / catatan. WAJIB diverifikasi tim compliance sebelum produksi. */
  basis: string;
  /** Konsekuensi jika terlambat, ditampilkan di notifikasi (mis. rentang denda). */
  risk?: string;
}

export type DeadlineStatus =
  | 'DONE'
  | 'DONE_LATE'
  | 'SCHEDULED'
  | 'WARNING' // <= 24 jam
  | 'CRITICAL' // <= 6 jam
  | 'OVERDUE'
  | 'MISSING_DATA';

export interface Deadline {
  shipmentId: string;
  ruleCode: string;
  title: string;
  category: Category;
  owner: Owner;
  status: DeadlineStatus;
  /** ISO UTC; null jika data acuan belum ada. */
  dueAt: string | null;
  /** true jika dihitung dari fallback / asumsi (mis. cut-off pelayaran belum diinput). */
  estimated: boolean;
  /** Alasan estimasi, mis. "carrierCutoffs.SI belum diisi". */
  estimateNote?: string;
  risk?: string;
  completedAt?: string;
  hoursLeft?: number;
  missing?: string[];
  basis: string;
}

export type AlarmKind = 'REMINDER' | 'OVERDUE' | 'MISSING_DATA';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Alarm {
  /** Kunci idempoten — alarm dengan key sama hanya dikirim sekali. */
  key: string;
  kind: AlarmKind;
  severity: Severity;
  /** true untuk alarm terlambat lanjutan: kirim juga ke supervisor. */
  escalate: boolean;
  deadline: Deadline;
}
