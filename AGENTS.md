# Project Information for Agents

## Testing

- Test framework: `vitest` (not jest)
- Run all tests: `npm test`
- Run single test file: `npx vitest run src/__tests__/auth.test.ts`
- Skip slow tests: The load test (prices) is failing on main and should be skipped for local development

## Admin Credentials Migration

### Overview
The admin authentication system has been refactored to support multiple named admin credentials instead of a single shared `ADMIN_TOKEN`. This allows:
- Attribution of admin actions to specific administrators
- Individual revocation of admin access
- Clear audit trail of who created which API keys

### Migration Path

#### Legacy System (Deprecated)
- Single shared secret: `ADMIN_TOKEN` environment variable
- Used via `X-Admin-Token` header or `Authorization: Bearer <token>`
- All admin actions attributed to a single identity

#### New System
- Multiple named admin credentials stored in `admin_credentials` table
- Each credential has a unique name and is hashed before storage
- Admin actions are attributed to the specific credential used
- API keys record which admin credential created them via `createdByAdminId`

### Compatibility
The legacy `ADMIN_TOKEN` continues to work during migration for backward compatibility. The `resolveAdminIdentity()` function first checks the new credential system, then falls back to the legacy token if no named credential matches.

### API Changes

#### New Endpoints
- `POST /admin/credentials` - Create a new admin credential (returns plaintext once)
- `GET /admin/credentials` - List all admin credentials
- `DELETE /admin/credentials/:id` - Revoke an admin credential

#### Modified Endpoints
- `POST /admin/keys` - Now requires named admin credential, records `createdByAdminId`
- `DELETE /admin/keys/:id` - Now requires named admin credential
- `GET /admin/usage/:keyId` - Now requires named admin credential
- `GET /admin/usage` - Now requires named admin credential

### Database Schema Changes

#### New Model: AdminCredential
```prisma
model AdminCredential {
  id         String    @id @default(uuid())
  name       String    @unique
  hash       String    @unique
  revokedAt  DateTime? @map("revoked_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  @@map("admin_credentials")
}
```

#### Modified Model: ApiKey
Added field:
```prisma
createdByAdminId String? @map("created_by_admin_id")
```

### Migration Steps

1. Run database migration to add new tables and columns
2. Create admin credentials for each administrator:
   ```bash
   curl -X POST http://localhost:3002/admin/credentials \
     -H "Authorization: Bearer <legacy-admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"name": "admin-name"}'
   ```
3. Update tooling/scripts to use new credentials
4. Remove `ADMIN_TOKEN` from environment once all admins have migrated

### Testing
- Test file: `src/__tests__/auth.test.ts`
- Covers: credential generation, hashing, lookup, and admin route authentication
- Legacy token compatibility is tested via the `resolveAdminIdentity` function
