# Deployment

## Runtime and processes

Use Node.js **24.16.0** (`.nvmrc`), npm 10+ and PostgreSQL 15. Node 20 is no longer the pinned runtime. Run three processes: Next.js dashboard/BFF, Express API, and background worker. Docker Compose currently supplies only PostgreSQL.

Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local`. Replace placeholders with secrets before starting. The backend loads its environment relative to its own directory, including when compiled output is launched from the repository root.

Required security configuration:

- A random `ENCRYPTION_KEY` containing exactly 64 hex characters, with `ENCRYPTION_KEY_VERSION`.
- A separate random `INTERNAL_AUTH_SECRET` of at least 32 characters, identical on backend/frontend.
- A separate `NEXTAUTH_SECRET`, GitHub OAuth client ID/secret and correct HTTPS `NEXTAUTH_URL` on the frontend.
- `BACKEND_INTERNAL_URL`, ending in `/api`, reachable only over a trusted private network or TLS. The OAuth bootstrap transmits the GitHub credential over this connection.
- Backend `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`, public HTTPS `GITHUB_WEBHOOK_URL` and explicit `CORS_ORIGIN` allowlist.
- Installation `GEMINI_API_KEY`, an available `GEMINI_MODEL` and bounded `GEMINI_TIMEOUT_MS` (default 60000, maximum 90000).

Never expose encryption/signing keys through `NEXT_PUBLIC_*`. Missing signing/encryption configuration prevents backend startup. Webhook URLs with credentials or a fragment are rejected. Register the OAuth callback as `<NEXTAUTH_URL>/api/auth/callback/github`.

## Fresh database

```bash
npm ci
npm run db:generate
npm run db:migrate:deploy
npm run typecheck
npm test
npm run build:backend
npm run build:frontend
```

Use placeholders only in build/test environments that never connect to real accounts. Apply migrations with an appropriate database role and retain a backup before schema changes.

## Existing database without migration history

Do not apply the initial migration blindly to tables created by `prisma db push`.

1. Pause API/worker and take a restorable backup.
2. Compare the existing tables, enums, indexes and foreign keys to `backend/prisma/migrations/20261108000000_init/migration.sql`. Rehearse against a restored copy.
3. If and only if they match that baseline, mark that migration applied:

   ```bash
   npm --workspace=backend exec -- prisma migrate resolve --applied 20261108000000_init
   ```

4. If they differ, reconcile explicitly before baseline; do not reset or fabricate a successful migration.
5. Apply subsequent migrations with `npm run db:migrate:deploy` and verify `npm run db:migrate:status`.
6. Existing active repositories without a known hook ID become inactive with an explicit reconciliation error. Retry their configuration in the dashboard. Historical in-process pending logs without a persisted run are marked interrupted; they cannot be replayed automatically.

## Credential backfill and session migration

Before exposing the updated application, back up the database and keys, configure the encryption key, and run:

```bash
npm --workspace=backend run credentials:migrate
```

This migrates plaintext tokens to authenticated encryption and clears the old column. It also supports re-encryption with the current key during rotation. It does not print tokens. Existing credentials remain readable during the transition; verify all plaintext fields are empty before retiring legacy storage in a later migration. A backup created before backfill still contains plaintext and must be protected.

Sessions created before the canonical identity exchange are invalidated logically and require a new sign-in. On sign-in the backend verifies the OAuth token with GitHub, encrypts it, and returns identity to NextAuth. The browser session/JWT no longer contains that GitHub token.

## Start compiled processes

```bash
node backend/dist/server.js
npm --workspace=backend run worker:start
npm --workspace=frontend start
```

Run these separately under your process supervisor. `npm run worker` is the development watch command, not the production worker command. Allow graceful shutdown time for an active job; forceful termination is recovered through leases.

Expose only dashboard routes and the public webhook route as needed. Protect internal API traffic with TLS/private networking in addition to signed assertions. Probe API liveness/readiness separately; inspect persisted job progress to assess the worker. Do not claim readiness of GitHub/Gemini from a successful database probe.

Before rollout, run PostgreSQL integration tests on a dedicated local `_test` database, a backup restoration exercise, and an explicit external smoke test with disposable credentials/repository. Unit tests and builds do not prove live OAuth/model availability.
