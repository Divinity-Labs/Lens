---
'lens': minor
---

Named admin credentials and a default lifetime for new API keys. `POST /admin/credentials` mints an `admin_…` credential (shown once, stored hashed) that is accepted anywhere `ADMIN_TOKEN` is, in `X-Admin-Token` or as a bearer token, so each key can be attributed to the admin who minted it and one admin can be revoked with `DELETE /admin/credentials/:id`. The shared `ADMIN_TOKEN` keeps working (attributed as `legacy-admin`) and remains the bootstrap secret for the first credential. New keys record `created_by_admin_id` and expire after `API_KEY_DEFAULT_LIFETIME_DAYS` (default 365; `0` disables) unless `expiresAt` is given. Adds migration `20261028000000_add_admin_credentials`.