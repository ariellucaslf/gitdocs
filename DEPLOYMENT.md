# GitDocs Deployment Guide

This guide details the reproduction, deployment, and execution of GitDocs across production and staging environments.

---

## 1. Supported Environments & Runtime

- **Node.js**: `v20.18.0` LTS (engine constraint: `>=20.17.0 <25.0.0`). Pin with `.nvmrc` (`nvm use`).
- **npm**: `>=10.0.0`.
- **Database**: PostgreSQL 15+ (tested on PostgreSQL 16).
- **TLS/HTTPS**: Mandatory for `GITHUB_WEBHOOK_URL` in production environments.

---

## 2. Environment Configuration

Copy `.env.example` templates to both `backend/.env` and `frontend/.env`:

### Backend Configuration (`backend/.env`)
```bash
PORT=4000
NODE_ENV=production
DATABASE_URL="postgresql://gitdocs_user:secret_password@db-host:5432/gitdocs_db?schema=public"

# Secrets & Security
GITHUB_CLIENT_ID="<your-github-oauth-client-id>"
GITHUB_CLIENT_SECRET="<your-github-oauth-client-secret>"
GITHUB_WEBHOOK_SECRET="<random-32-byte-hex-string>"
GITHUB_WEBHOOK_URL="https://api.yourdomain.com/api/webhooks"
CORS_ORIGIN="https://dashboard.yourdomain.com"

# Server-Side Token Encryption (AES-256-GCM, 32 bytes hex)
ENCRYPTION_KEY="<64-hex-character-key>"
ENCRYPTION_KEY_VERSION="v1"
# Optional during rotation: ENCRYPTION_KEY_PREVIOUS="<old-64-hex-character-key>"

# Internal Server-to-Server BFF Secret
INTERNAL_AUTH_SECRET="<random-32-byte-hex-string>"

# AI Integration
GEMINI_API_KEY="<google-gemini-api-key>"
GEMINI_MODEL="gemini-2.5-flash"
GEMINI_TIMEOUT_MS=60000
```

### Frontend Configuration (`frontend/.env`)
```bash
NEXTAUTH_URL="https://dashboard.yourdomain.com"
NEXTAUTH_SECRET="<random-32-byte-hex-string>"
GITHUB_CLIENT_ID="<your-github-oauth-client-id>"
GITHUB_CLIENT_SECRET="<your-github-oauth-client-secret>"
INTERNAL_AUTH_SECRET="<same-secret-as-backend-INTERNAL_AUTH_SECRET>"
BACKEND_INTERNAL_URL="http://backend-internal-host:4000/api"
```

---

## 3. Clean Installation & Build

Run the following commands from the root directory:

```bash
# 1. Clean reproducible dependency install
npm ci

# 2. Generate Prisma Client
npm run db:generate

# 3. Apply versioned database migrations
npm run db:migrate:deploy

# 4. Compile TypeScript & Build Frontend/Backend
npm run build:backend
npm run build:frontend
```

---

## 4. Process Architecture & Execution

GitDocs runs two distinct processes:

1. **HTTP API Server**:
   ```bash
   node backend/dist/server.js
   ```
   Exposes HTTP endpoints, admissions, and `/health/readiness`.

2. **Autonomous Background Worker**:
   ```bash
   npm run worker
   ```
   Executes distributed leases, diff analysis, and reconciliation jobs.

3. **Frontend Dashboard (Next.js)**:
   ```bash
   npm --workspace=frontend start
   ```

---

## 5. Health Checks & Verification

- **Liveness probe**: `GET /health` or `GET /health/liveness` (returns 200).
- **Readiness probe**: `GET /health/readiness` (pings PostgreSQL database; returns 200 when ready, 503 when disconnected).
