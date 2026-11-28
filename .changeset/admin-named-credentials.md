---
'lens': minor
---

Named admin credentials. `POST /admin/credentials` mints an `admin_…` credential (shown once, stored hashed) that is accepted anywhere `ADMIN_TOKEN` is, in `X-Admin-Token` or as a bearer token, so each API key records the admin who minted it (`created_by_admin_id`) and one admin can be revoked with `DELETE /admin/credentials/:id`. The shared `ADMIN_TOKEN` keeps working (attributed as `legacy-admin`) and remains the bootstrap secret for the first credential. Adds migration `20261028000000_add_admin_credentials`.