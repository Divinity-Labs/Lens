# Deployment and Database Migration Guide

This document describes the deployment procedure for the Lens database and application services.

---

## Database Migrations: `prisma migrate deploy`

Lens uses **Prisma Migrate** for all schema updates.

### Production Migration Command
```bash
npx prisma migrate deploy
```

### Why `prisma db push` is Strictly Prohibited in Production
1. **Unpredictable Schema Diffs:** `db push` inspects the live database connection and immediately alters tables without reviewable SQL statements.
2. **Data Loss Risk:** `db push` can silently drop columns, indexes, or composite partitions when models are modified or renamed.
3. **No Migration History:** `db push` leaves no audit trail or rollback record in `_prisma_migrations`, making rollbacks impossible.
4. **Reproducibility:** Every deployment stage (local, test, staging, production) must execute the exact byte-for-byte migration sequence recorded under `prisma/migrations/`.

---

## Zero-Downtime Rollout Steps
1. **Pre-Deployment:**
   - Execute tests: `npm test`
   - Verify migration drift: `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-migrations prisma/migrations --exit-code`
2. **Database Migration:**
   - Run `npx prisma migrate deploy`
3. **Application Deploy:**
   - Start or restart worker and API containers using `npm start`
4. **Post-Deployment Verification:**
   - Verify health probe: `GET /status` returns HTTP 200 `{ "ok": true, "status": "healthy" }`
