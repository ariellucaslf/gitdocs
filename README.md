# GitDocs & PR-Committer

GitDocs is a self-hosted GitHub pull request assistant. It analyzes code changes with Google Gemini, posts a structured review, and proposes focused README patches that a repository owner can approve in the dashboard.

Documentation changes require explicit approval. The legacy README autocommit switch is disabled, including for repositories where it was previously enabled.

## How it works

1. Sign in with GitHub. The NextAuth server exchanges the OAuth credential with the backend, which stores it encrypted. The browser receives identity only.
2. Enable monitoring on a repository where you have administrative permissions. The server provisions a signed HTTPS webhook and exposes its actual provisioning state.
3. A verified pull request delivery is admitted atomically to PostgreSQL. Duplicate delivery IDs and duplicate revisions do not create another run.
4. A separate worker leases the run, checks that its PR revision is current, analyzes a filtered diff, persists the analysis, and publishes a comment marked with the run ID and analyzed SHA.
5. When enough context exists, a documentation proposal contains limited replacements against the README at that revision. Review the patch and preview, then approve or reject it.
6. Approved changes use a non-force Git ref update. Fork PRs receive suggestions only. Stale proposals cannot overwrite newer work.

```mermaid
flowchart LR
    User --> Next[Next.js dashboard and BFF]
    Next --> API[Express API]
    GitHub -->|signed webhook| API
    API --> DB[(PostgreSQL)]
    DB --> Worker
    Worker --> Gemini
    Worker -->|review comment| GitHub
    User -->|explicit proposal approval| Next
    API -->|approved README commit| GitHub
```

The API does not start a background review after accepting a webhook. Keep the worker running alongside it. External effects are reconciled after ambiguous failures; this is recoverable processing, not a guarantee of exactly-once execution on GitHub.

## Repository structure

| Location | Purpose |
| --- | --- |
| `backend/src/controllers/`, `routes/`, `middlewares/` | HTTP validation, ownership and authentication |
| `backend/src/worker/` | Persistent queue, leases, fencing and review workflow |
| `backend/src/services/` | GitHub/Gemini adapters, encryption, hook provisioning and documentation proposals |
| `backend/prisma/` | Database schema and versioned migrations |
| `backend/tests/` | Unit, HTTP, frontend boundary and PostgreSQL integration tests |
| `frontend/src/` | Next.js App Router dashboard, server-side OAuth and restricted BFF proxy |
| `.github/workflows/ci.yml` | Types, migrations, tests and production builds |

Stack: Node.js 24.16.0, npm Workspaces, Next.js 16 / React 19, Express 4, TypeScript, Prisma 5, PostgreSQL 15 and the maintained `@google/genai` SDK. Dependencies are locked in `package-lock.json`.

## Local development

Prerequisites: the Node version in `.nvmrc`, npm 10+, Docker Compose, a development GitHub OAuth App, and a Gemini API key/model available in your Google project.

```bash
npm ci
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

Edit both files before starting the applications. Generate separate random secrets, for example with `openssl rand -hex 32`. `ENCRYPTION_KEY` must be exactly 64 hex characters. Use the same `INTERNAL_AUTH_SECRET` on both servers; keep it separate from `NEXTAUTH_SECRET`. No built-in signing/encryption secrets are used.

Set your OAuth callback to `http://localhost:3000/api/auth/callback/github`. Set `GEMINI_MODEL` explicitly to a currently available model. The key belongs to the installation, not to each dashboard user.

```bash
docker compose up -d postgres
npm run db:generate
npm run db:migrate:deploy
```

Run each process in its own terminal:

```bash
npm run dev:backend
npm run worker
npm run dev:frontend
```

Open [the local dashboard](http://localhost:3000). A real GitHub webhook needs a public HTTPS address forwarded to the backend's `/api/webhooks`. Configure that address in `GITHUB_WEBHOOK_URL`; changing a browser URL or frontend API variable does not change webhook routing. HTTP localhost alone cannot receive GitHub deliveries.

For an existing database created by `db:push`, follow the baseline procedure in [DEPLOYMENT.md](DEPLOYMENT.md) before applying migrations. Do not reset existing data or use `db:push` in production.

## Verification

```bash
npm run typecheck
npm test
npm run build:backend
npm run build:frontend
```

The frontend production build uses Webpack explicitly for reproducibility across restricted build environments. Tests do not call GitHub or Gemini.

PostgreSQL integration tests require an explicit isolated local database whose name ends in `_test`. They apply migrations and clean up only their own fixture users/repositories:

```bash
TEST_DATABASE_URL="postgresql://test_user:test_password@127.0.0.1:55436/gitdocs_review_test" npm run test:integration
```

The runner refuses non-test database names, non-local hosts and production mode. `/health` and `/health/liveness` check the API process; `/health/readiness` checks database connectivity. These endpoints do not prove the worker or external providers are healthy.

## Boundaries and data policy

- Each repository has one local responsible user. Shared organization memberships and GitHub App installation credentials are not implemented.
- GitHub OAuth currently requests `repo` and `write:repo_hook` scopes. Use a trusted deployment and dedicated test repositories when evaluating it.
- Known credential files and binary/lock artifacts are excluded; recognizable secrets are redacted. These filters cannot guarantee that arbitrary code is free of sensitive data. Enabling analysis sends retained diffs, bounded PR metadata and README context to Google.
- Truncated input is identified in the review; automatic documentation proposals are disabled when context is incomplete.
- Proposals target only a regular UTF-8 root `README.md`, with at most 10 replacements and 20 KiB of new text. Symlinks, other paths, ambiguous replacements and whole-document replacements are rejected.
- Job results and proposals persist in PostgreSQL. Automated retention and a community pilot are still future work; operators must control access and deletion.
- UI search/filters operate on the displayed page. Repository/log pagination and summary totals come from the server.

See [DEPLOYMENT.md](DEPLOYMENT.md) for production setup and [OPERATIONS.md](OPERATIONS.md) for recovery and credential rotation. The software is an assistant; evaluate suggestions before applying them.

## License

[MIT](LICENSE).
