import 'reflect-metadata';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { signWebhook } from '@ff/deadline-alarm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { AlarmScheduler } from '../src/alarms/alarm.scheduler.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://ff:ff@localhost:5432/ff_test';
const API_KEY = 'test-key-0123456789abcdefghij';
const SECRET = 'webhook-secret-0123456789abcdefghijklmnop';

// ---------------------------------------------------------------- kanal webhook tiruan (bukan n8n khususnya)
interface Hook {
  headers: IncomingMessage['headers'];
  raw: string;
  body: { key: string; kind: string; recipient: string | null; text: string; escalate: boolean };
}
const hooks: Hook[] = [];
let hookStatus = 200;
const webhookServer: Server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    hooks.push({ headers: req.headers, raw, body: JSON.parse(raw) });
    res.writeHead(hookStatus).end();
  });
});

let app: NestExpressApplication;
let base: string;
let db: pg.Pool;

async function api(method: string, path: string, body?: unknown, key: string | null = API_KEY) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function exportJob(reference: string, over: Record<string, unknown> = {}) {
  return {
    reference,
    direction: 'EXPORT',
    mode: 'SEA',
    roles: ['PPJK'],
    masterDoc: { vesselName: 'KMTC JAKARTA', voyage: '2609N', portOfLoading: 'IDJKT', portOfDischarge: 'SGSIN', etd: hoursFromNow(72) },
    carrierCutoffs: { SI: hoursFromNow(5), CY: hoursFromNow(30) },
    pic: { DOCS: 'wa:+6281200000001', CUSTOMS: 'wa:+6281200000002', OPS: 'wa:+6281200000003' },
    ...over,
  };
}

before(async () => {
  // Test ini menghapus seluruh schema public: tolak database yang namanya tidak berakhiran _test.
  const dbName = new URL(DB_URL).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`TEST_DATABASE_URL harus menunjuk database *_test (sekarang: ${dbName})`);
  db = new pg.Pool({ connectionString: DB_URL });
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await new Promise<void>((r) => webhookServer.listen(0, r));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    API_KEYS: `other-key-0123456789abcdefgh,${API_KEY}`,
    ALARM_ENABLED: 'false', // tick dipanggil manual di test
    ALARM_WEBHOOK_URL: `http://127.0.0.1:${(webhookServer.address() as AddressInfo).port}/hook`,
    ALARM_WEBHOOK_SECRET: SECRET,
  });
  app = await createApp(config, { migrate: true, logger: false });
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  await app?.close();
  await db?.end();
  webhookServer.close();
});

beforeEach(() => {
  hooks.length = 0;
  hookStatus = 200;
});

describe('konfigurasi', () => {
  test('menolak env yang tidak aman', () => {
    assert.throws(() => loadConfig({ DATABASE_URL: DB_URL, API_KEYS: 'pendek' }), /API key minimal 24/);
    assert.throws(
      () => loadConfig({ DATABASE_URL: DB_URL, API_KEYS: API_KEY, ALARM_WEBHOOK_URL: 'http://x.test/h' }),
      /ALARM_WEBHOOK_SECRET/,
    );
  });

  test('production tidak butuh ALARM_WEBHOOK_URL — default log-only, tanpa n8n', () => {
    const c = loadConfig({ NODE_ENV: 'production', DATABASE_URL: DB_URL, API_KEYS: API_KEY });
    assert.equal(c.nodeEnv, 'production');
    assert.equal(c.alarm.webhookUrl, undefined);
  });

  test('baris .env kosong dianggap tidak diisi (sesuai .env.example)', () => {
    const c = loadConfig({ DATABASE_URL: DB_URL, API_KEYS: API_KEY, ALARM_WEBHOOK_URL: '', ALARM_WEBHOOK_SECRET: '', PORT: '' });
    assert.equal(c.alarm.webhookUrl, undefined);
    assert.equal(c.port, 3000);
  });

  test('migrasi idempoten', async () => {
    assert.deepEqual(await runMigrations(db), []);
  });
});

describe('HTTP API', () => {
  test('health publik, endpoint lain wajib API key', async () => {
    assert.equal((await api('GET', '/health', undefined, null)).status, 200);
    assert.equal((await api('GET', '/deadlines', undefined, null)).status, 401);
    assert.equal((await api('GET', '/deadlines', undefined, 'salah-key-0123456789abcdefgh')).status, 401);
    assert.equal((await api('GET', '/deadlines')).status, 200);
  });

  test('validasi input per field, 404, dan UUID tidak valid', async () => {
    const r = await api('POST', '/jobs', { reference: 'X', direction: 'SIDEWAYS', mode: 'SEA', masterDoc: { etd: '2026-09-25 22:00' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errors.map((e: { path: string }) => e.path).sort(), ['direction', 'masterDoc.etd']);
    assert.equal((await api('GET', '/jobs/3f0c8a52-8f0e-4f7a-9a55-6f7f3b1d2c11')).status, 404);
    assert.equal((await api('GET', '/jobs/bukan-uuid')).status, 400);
    const dup = await api('POST', '/jobs', exportJob('EXP/T/DUP', { containers: [{ number: 'MSCU0000001' }, { number: 'MSCU0000001' }] }));
    assert.equal(dup.status, 400);
    assert.match(dup.body.errors[0].message, /MSCU0000001 dobel/);
  });

  test('buat job, nomor job unik, deadline dihitung', async () => {
    const r = await api('POST', '/jobs', exportJob('EXP/T/001'));
    assert.equal(r.status, 201);
    const si = r.body.deadlines.find((d: { ruleCode: string }) => d.ruleCode === 'EXP_SI_CLOSING');
    assert.equal(si.status, 'CRITICAL');
    assert.equal(si.estimated, false);
    assert.equal((await api('POST', '/jobs', exportJob('EXP/T/001'))).status, 409);
  });

  test('PATCH cut-off: null menghapus → deadline jadi estimasi dari ETD', async () => {
    const { body } = await api('POST', '/jobs', exportJob('EXP/T/002'));
    const r = await api('PATCH', `/jobs/${body.job.id}`, { carrierCutoffs: { SI: null } });
    assert.equal(r.status, 200);
    const si = r.body.deadlines.find((d: { ruleCode: string }) => d.ruleCode === 'EXP_SI_CLOSING');
    assert.equal(si.estimated, true);
    assert.equal(si.dueAt, new Date(Date.parse(body.job.etd) - 48 * 3_600_000).toISOString());
  });

  test('milestone: set, koreksi (nilai lama dikembalikan), hapus, dan tercatat di audit log', async () => {
    const { body } = await api('POST', '/jobs', exportJob('EXP/T/003'));
    const id = body.job.id;
    const t1 = hoursFromNow(-2);
    let r = await api('POST', `/jobs/${id}/milestones`, { event: 'SI_SUBMITTED', occurredAt: t1 });
    assert.equal(r.body.deadlines.find((d: { ruleCode: string }) => d.ruleCode === 'EXP_SI_CLOSING').status, 'DONE');
    r = await api('POST', `/jobs/${id}/milestones`, { event: 'SI_SUBMITTED', occurredAt: hoursFromNow(-1) });
    assert.equal(r.body.previous, t1);
    assert.equal((await api('DELETE', `/jobs/${id}/milestones/SI_SUBMITTED`)).status, 200);
    assert.equal((await api('DELETE', `/jobs/${id}/milestones/BUKAN_EVENT`)).status, 400);
    const future = await api('POST', `/jobs/${id}/milestones`, { event: 'SI_SUBMITTED', occurredAt: hoursFromNow(3) });
    assert.equal(future.status, 400);
    assert.equal(future.body.errors[0].path, 'occurredAt');
    const audit = await db.query('SELECT action, actor FROM audit_log WHERE job_id = $1 ORDER BY id', [id]);
    assert.deepEqual(audit.rows.map((a) => a.action), ['JOB_CREATED', 'MILESTONE_SET', 'MILESTONE_CORRECTED', 'MILESTONE_DELETED']);
    assert.match(audit.rows[0].actor, /^api-key:[0-9a-f]{8}$/);
  });

  test('tracking DCSA incremental: gate-out baru terisi setelah semua container, event ulang tidak dobel', async () => {
    const { body } = await api('POST', '/jobs', {
      reference: 'IMP/T/001',
      direction: 'IMPORT',
      mode: 'SEA',
      masterDoc: { portOfLoading: 'SGSIN', portOfDischarge: 'IDJKT', eta: hoursFromNow(-96) },
      containers: [{ number: 'MSCU0000001' }, { number: 'MSCU0000002' }],
      freeTime: { demurrageDays: 5, detentionDays: 7 },
    });
    const id = body.job.id;
    const eq = (code: string, ref: string, at: string) => ({
      eventType: 'EQUIPMENT', eventClassifierCode: 'ACT', equipmentEventTypeCode: code, equipmentReference: ref,
      emptyIndicatorCode: 'LADEN', eventDateTime: at, location: { UNLocationCode: 'IDJKT' },
    });
    const arri = { eventType: 'TRANSPORT', eventClassifierCode: 'ACT', transportEventTypeCode: 'ARRI', eventDateTime: hoursFromNow(-90), location: { UNLocationCode: 'IDJKT' } };

    let r = await api('POST', `/jobs/${id}/tracking-events`, [arri, eq('DISC', 'MSCU0000001', hoursFromNow(-80)), eq('GTOT', 'MSCU0000001', hoursFromNow(-10))]);
    assert.equal(r.status, 200);
    assert.equal(r.body.stored, 3);
    assert.equal(r.body.job.ata, arri.eventDateTime);
    assert.ok(r.body.job.events.CONTAINER_DISCHARGED);
    assert.equal(r.body.job.events.CONTAINER_GATE_OUT, undefined);

    // Webhook kedua hanya berisi event baru + satu event lama yang dikirim ulang dengan offset berbeda.
    const again = { ...arri, eventDateTime: new Date(arri.eventDateTime).toISOString().replace('Z', '+00:00') };
    const out2 = hoursFromNow(-5);
    r = await api('POST', `/jobs/${id}/tracking-events`, [again, eq('GTOT', 'MSCU0000002', out2)]);
    assert.equal(r.body.stored, 1);
    assert.equal(r.body.job.events.CONTAINER_GATE_OUT, out2);
    const dm = r.body.deadlines.find((d: { ruleCode: string }) => d.ruleCode === 'IMP_DEMURRAGE_FREE_TIME');
    assert.equal(dm.status, 'DONE');
    const src = await db.query(`SELECT source FROM milestone WHERE job_id = $1 AND event = 'CONTAINER_GATE_OUT'`, [id]);
    assert.equal(src.rows[0].source, 'DCSA');
  });

  test('tracking DCSA: event ACT bertanggal masa depan tidak disimpan dan tidak menutup milestone', async () => {
    const { body } = await api('POST', '/jobs', {
      reference: 'IMP/T/003', direction: 'IMPORT', mode: 'SEA',
      masterDoc: { portOfLoading: 'SGSIN', portOfDischarge: 'IDJKT', eta: hoursFromNow(-48) },
      containers: [{ number: 'MSCU0000009' }],
      freeTime: { demurrageDays: 5 },
    });
    const ev = (cls: string, at: string) => ({
      eventType: 'EQUIPMENT', eventClassifierCode: cls, equipmentEventTypeCode: 'GTOT', equipmentReference: 'MSCU0000009',
      emptyIndicatorCode: 'LADEN', eventDateTime: at, location: { UNLocationCode: 'IDJKT' },
    });
    const r = await api('POST', `/jobs/${body.job.id}/tracking-events`, [ev('ACT', hoursFromNow(48)), ev('EST', hoursFromNow(24))]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignoredFutureActual, 1);
    assert.equal(r.body.stored, 1); // hanya EST
    assert.equal(r.body.job.events.CONTAINER_GATE_OUT, undefined);
    const dm = r.body.deadlines.find((d: { ruleCode: string }) => d.ruleCode === 'IMP_DEMURRAGE_FREE_TIME');
    assert.notEqual(dm.status, 'DONE');
  });

  test('tracking DCSA: ETA estimasi yang terakhir diterima yang dipakai', async () => {
    const { body } = await api('POST', '/jobs', {
      reference: 'IMP/T/002', direction: 'IMPORT', mode: 'SEA',
      masterDoc: { portOfLoading: 'SGSIN', portOfDischarge: 'IDJKT', eta: hoursFromNow(100) },
    });
    const est = (at: string) => ({ eventType: 'TRANSPORT', eventClassifierCode: 'EST', transportEventTypeCode: 'ARRI', eventDateTime: at, location: { UNLocationCode: 'IDJKT' } });
    const later = hoursFromNow(120);
    const earlier = hoursFromNow(90);
    await api('POST', `/jobs/${body.job.id}/tracking-events`, [est(later)]);
    let r = await api('POST', `/jobs/${body.job.id}/tracking-events`, [est(earlier)]);
    assert.equal(r.body.job.eta, earlier);
    // Provider mengirim ulang estimasi lama → estimasi itu yang terbaru lagi.
    r = await api('POST', `/jobs/${body.job.id}/tracking-events`, [est(later)]);
    assert.equal(r.body.job.eta, later);
  });

  test('GET /deadlines: filter PIC & status, urut paling mendesak', async () => {
    const r = await api('GET', '/deadlines?owner=DOCS&status=CRITICAL,MISSING_DATA');
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0);
    assert.ok(r.body.every((d: { owner: string; status: string }) => d.owner === 'DOCS' && ['CRITICAL', 'MISSING_DATA'].includes(d.status)));
    assert.equal(r.body[0].status, 'CRITICAL');
    assert.equal(r.body[0].pic, 'wa:+6281200000001');
    assert.equal((await api('GET', '/deadlines?status=BUKAN')).status, 400);
  });
});

describe('scheduler alarm', () => {
  test('tanpa ALARM_WEBHOOK_URL: alarm log-only, tetap tercatat SENT di DB, tanpa n8n', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, API_KEYS: API_KEY, ALARM_ENABLED: 'false' });
    assert.equal(config.alarm.webhookUrl, undefined);
    const logOnlyApp = await createApp(config, { logger: false });
    try {
      await db.query(`UPDATE job SET status = 'CLOSED'`);
      const { body } = await api('POST', '/jobs', exportJob('EXP/T/105'));
      const before = hooks.length;
      const t1 = await logOnlyApp.get(AlarmScheduler).tick();
      assert.ok(t1.sent > 0);
      assert.equal(hooks.length, before, 'tidak ada request keluar sama sekali (bukan cuma webhook yang gagal)');
      const stored = await db.query(`SELECT status, sent_at FROM deadline_alarm_sent WHERE job_id = $1`, [body.job.id]);
      assert.equal(stored.rows.length, t1.sent);
      assert.ok(stored.rows.every((r) => r.status === 'SENT' && r.sent_at));
    } finally {
      await logOnlyApp.close();
    }
  });

  test('mengirim ke webhook eksternal (opsional, bisa n8n atau apa pun) dengan tanda tangan HMAC, dan tidak mengirim ulang', async () => {
    await db.query(`UPDATE job SET status = 'CLOSED'`);
    const { body } = await api('POST', '/jobs', exportJob('EXP/T/100'));
    const scheduler = app.get(AlarmScheduler);

    const t1 = await scheduler.tick();
    assert.equal(t1.ran, true);
    assert.equal(t1.jobs, 1);
    assert.ok(t1.sent >= 2);
    assert.equal(hooks.length, t1.sent);

    for (const h of hooks) {
      const ts = Number(h.headers['x-ff-timestamp']);
      assert.ok(Math.abs(Date.now() / 1000 - ts) < 60);
      assert.equal(h.headers['x-ff-signature'], signWebhook(SECRET, h.raw, ts));
    }
    const si = hooks.find((h) => h.body.key.includes('EXP_SI_CLOSING'))!;
    assert.equal(si.body.recipient, 'wa:+6281200000001');
    assert.match(si.body.text, /EXP\/T\/100/);

    const stored = await db.query('SELECT count(*)::int AS n FROM deadline_alarm_sent WHERE job_id = $1', [body.job.id]);
    assert.equal(stored.rows[0].n, t1.sent);
    assert.equal((await scheduler.tick()).sent, 0);
  });

  test('webhook gagal → klaim dilepas, terkirim di tick berikutnya', async () => {
    await db.query(`UPDATE job SET status = 'CLOSED'`);
    await api('POST', '/jobs', exportJob('EXP/T/101'));
    const scheduler = app.get(AlarmScheduler);
    hookStatus = 500;
    const t1 = await scheduler.tick();
    assert.equal(t1.sent, 0);
    assert.ok(t1.failed > 0);
    hookStatus = 200;
    const t2 = await scheduler.tick();
    assert.equal(t2.sent, t1.failed);
  });

  test('tick paralel (mis. dua instance) tidak mengirim alarm dobel', async () => {
    await db.query(`UPDATE job SET status = 'CLOSED'`);
    await api('POST', '/jobs', exportJob('EXP/T/102'));
    const scheduler = app.get(AlarmScheduler);
    // Simulasikan instance lain: panggil doTick langsung dua kali (melewati penggabungan in-process).
    const doTick = (scheduler as unknown as { doTick: () => Promise<{ sent: number }> }).doTick.bind(scheduler);
    const results = await Promise.all([doTick(), doTick(), doTick()]);
    const keys = hooks.map((h) => h.body.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(results.reduce((n, r) => n + r.sent, 0), keys.length);
  });

  test('klaim yang tertinggal (proses mati sebelum konfirmasi) dikirim ulang setelah lease habis', async () => {
    await db.query(`UPDATE job SET status = 'CLOSED'`);
    const { body } = await api('POST', '/jobs', exportJob('EXP/T/104'));
    const scheduler = app.get(AlarmScheduler);
    // Simulasi crash: klaim sudah ditulis (PENDING) tapi webhook tidak pernah terkonfirmasi.
    const key = `${body.job.id}:EXP_SI_CLOSING:${body.deadlines.find((d: { ruleCode: string }) => d.ruleCode === 'EXP_SI_CLOSING').dueAt}:R6`;
    await db.query(
      `INSERT INTO deadline_alarm_sent (alarm_key, job_id, rule_code, kind, severity, escalate) VALUES ($1, $2, 'EXP_SI_CLOSING', 'REMINDER', 'CRITICAL', false)`,
      [key, body.job.id],
    );
    await scheduler.tick();
    assert.ok(!hooks.some((h) => h.body.key === key), 'klaim yang masih dalam lease tidak boleh diambil alih');

    await db.query(`UPDATE deadline_alarm_sent SET claimed_at = now() - interval '1 hour' WHERE alarm_key = $1`, [key]);
    await scheduler.tick();
    assert.equal(hooks.filter((h) => h.body.key === key).length, 1);
    const row = await db.query('SELECT status, sent_at FROM deadline_alarm_sent WHERE alarm_key = $1', [key]);
    assert.equal(row.rows[0].status, 'SENT');
    assert.ok(row.rows[0].sent_at);

    await db.query(`UPDATE deadline_alarm_sent SET claimed_at = now() - interval '1 hour' WHERE alarm_key = $1`, [key]);
    await scheduler.tick();
    assert.equal(hooks.filter((h) => h.body.key === key).length, 1, 'yang sudah SENT tidak dikirim lagi');
  });

  test('override rule dari tabel deadline_rule: nonaktifkan & rule tidak valid diabaikan', async () => {
    const { body } = await api('POST', '/jobs', exportJob('EXP/T/103'));
    const codes = async () => (await api('GET', `/jobs/${body.job.id}`)).body.deadlines.map((d: { ruleCode: string }) => d.ruleCode);
    assert.ok((await codes()).includes('EXP_DRAFT_BL'));
    await db.query(`INSERT INTO deadline_rule (code, definition, active) VALUES ('EXP_DRAFT_BL', '{}', false)`);
    await db.query(`INSERT INTO deadline_rule (code, definition) VALUES ('EXP_SI_CLOSING', '{"title": "rusak"}')`);
    const after = await codes();
    assert.ok(!after.includes('EXP_DRAFT_BL'));
    assert.ok(after.includes('EXP_SI_CLOSING'), 'rule default tetap dipakai bila override tidak valid');
    await db.query('DELETE FROM deadline_rule');
  });
});

describe('GET /alarms & acknowledge', () => {
  test('daftar alarm terkirim, filter kind/severity/owner/acknowledged, dan ack idempoten', async () => {
    await db.query(`UPDATE job SET status = 'CLOSED'`);
    const { body } = await api('POST', '/jobs', exportJob('EXP/T/200'));
    const scheduler = app.get(AlarmScheduler);
    await scheduler.tick();

    const all = await api('GET', `/alarms?jobId=${body.job.id}`);
    assert.equal(all.status, 200);
    assert.ok(all.body.length > 0);
    assert.ok(all.body.every((a: { jobReference: string }) => a.jobReference === 'EXP/T/200'));

    const reminder = all.body.find((a: { kind: string }) => a.kind === 'REMINDER');
    const critical = await api('GET', `/alarms?jobId=${body.job.id}&severity=CRITICAL`);
    assert.ok(critical.body.every((a: { severity: string }) => a.severity === 'CRITICAL'));
    const docsOnly = await api('GET', `/alarms?jobId=${body.job.id}&owner=DOCS`);
    assert.ok(docsOnly.body.length > 0 && docsOnly.body.length <= all.body.length);

    const notFound = await api('POST', '/alarms/tidak-ada/ack');
    assert.equal(notFound.status, 404);

    const ack1 = await api('POST', `/alarms/${reminder.alarmKey}/ack`);
    assert.equal(ack1.status, 200);
    assert.match(ack1.body.acknowledgedBy, /^api-key:[0-9a-f]{8}$/);
    const firstAckAt = ack1.body.acknowledgedAt;

    // Acknowledge kedua (aktor lain) tidak menimpa yang pertama.
    const ack2 = await api('POST', `/alarms/${reminder.alarmKey}/ack`, undefined, `other-key-0123456789abcdefgh`);
    assert.equal(ack2.body.acknowledgedBy, ack1.body.acknowledgedBy);
    assert.equal(ack2.body.acknowledgedAt, firstAckAt);

    const pending = await api('GET', `/alarms?jobId=${body.job.id}&acknowledged=false`);
    assert.ok(!pending.body.some((a: { alarmKey: string }) => a.alarmKey === reminder.alarmKey));
    const done = await api('GET', `/alarms?jobId=${body.job.id}&acknowledged=true`);
    assert.ok(done.body.some((a: { alarmKey: string }) => a.alarmKey === reminder.alarmKey));
  });
});
