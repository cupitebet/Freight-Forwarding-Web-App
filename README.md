# Freight-Forwarding-Web-App
Freight Forwarding Web App

- `Freight Forwarder App & API Bea Cukai.docx`: blueprint arsitektur (NestJS + n8n + CEISA 4.0 H2H)
- `docs/REVIEW.md`: review blueprint, insight, evaluasi repo open-source, dan usulan model data
- `apps/api`: core API NestJS + PostgreSQL (job, milestone, tracking DCSA, scheduler alarm) — lihat README-nya
- `packages/deadline-alarm`: engine alarm cut-off pelayaran, manifes BC 1.1, PEB/PIB, dan free time
- `docs/LOCAL-WINDOWS.md`: **panduan Windows** (setup satu perintah, smoke test, upgrade)

Windows: `powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1 -Test`, lalu `npm start` (lihat `docs/LOCAL-WINDOWS.md`).

Linux/macOS:

```bash
cp .env.example .env          # isi API_KEYS (openssl rand -hex 24)
docker compose up -d db       # juga membuat database ff_test
npm ci && npm run build && npm run migrate
npm test                      # unit + e2e (database *_test dikosongkan)
npm start
```
