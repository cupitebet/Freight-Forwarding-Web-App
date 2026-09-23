# Freight-Forwarding-Web-App
Freight Forwarding Web App

- `Freight Forwarder App & API Bea Cukai.docx`: blueprint arsitektur (NestJS + n8n + CEISA 4.0 H2H)
- `docs/REVIEW.md`: review blueprint, insight, evaluasi repo open-source, dan usulan model data
- `apps/api`: core API NestJS + PostgreSQL (job, milestone, tracking DCSA, scheduler alarm) — lihat README-nya
- `packages/deadline-alarm`: engine alarm cut-off pelayaran, manifes BC 1.1, PEB/PIB, dan free time

```bash
npm ci
npm run build
npm run typecheck
TEST_DATABASE_URL=postgres://ff:ff@localhost:5432/ff_test npm test
```
