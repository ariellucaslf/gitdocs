# 🛠️ GitDocs & PR-Committer

<div align="center">

![Next.js](https://img.shields.io/badge/Next.js_14-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript_5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma_ORM-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL_15-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Gemini_1.5_Flash-8E75B2?style=for-the-badge&logo=google&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-emerald?style=for-the-badge)

<p align="center">
  <strong>Automated GitHub Pull Request reviews and smart documentation bot powered by Google Gemini AI and Next.js 14.</strong>
</p>

[Key Features](#-key-features) • [Architecture](#-architecture) • [Quick Start](#-quick-start) • [Environment Variables](#-environment-variables) • [Tech Stack](#-tech-stack)

</div>

---

## 📌 Overview

**GitDocs** is an open-source, developer-first tool designed to automate Pull Request code reviews and keep documentation always synchronized with structural code changes:

1. **Dashboard Portal (Next.js 14 App Router)**: Authenticate with GitHub OAuth, inspect your repositories, toggle webhook monitoring on/off, and view live review execution logs.
2. **Webhook Receiver & Security (Express + TypeScript)**: Receives GitHub PR webhooks with cryptographic HMAC SHA-256 signature verification (`x-hub-signature-256`).
3. **AI Code Review Engine (Google Gemini 1.5 Flash)**: Sanitizes raw diffs (ignoring lockfiles and binaries), categorizes changes (*Features, Bug Fixes, Refactoring, Breaking Changes*), and generates clean Markdown review checklists.
4. **Automated PR Comments & README Commits**: Posts comments directly to the GitHub PR. If structural changes are introduced and `autoCommitReadme` is active, the bot commits updated documentation directly to the PR branch.

---

## 📐 Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant GH as GitHub (PR & Webhooks)
    participant Web as Next.js Dashboard
    participant API as Express Backend
    participant DB as PostgreSQL (Prisma)
    participant AI as Google Gemini 1.5

    Dev->>Web: Log in with GitHub OAuth
    Web-->>Dev: Authenticated Session (Access Token)
    Dev->>Web: Toggle monitoring on repository (e.g., repo-A)
    Web->>API: POST /api/repositories/toggle
    API->>GH: Create Webhook on repo-A via Octokit
    API->>DB: Save Repository state (isActive: true)
    API-->>Web: Success response

    Note over Dev,GH: Developer opens or syncs a Pull Request
    GH->>API: POST /api/webhooks (HMAC SHA-256 verified)
    API->>DB: Create WebhookLog (Status: PENDING)
    API-->>GH: HTTP 202 Accepted
    
    rect rgb(20, 30, 45)
        Note over API,AI: Asynchronous Background Processing
        API->>GH: Fetch raw PR diff file
        GH-->>API: Return Diff content
        API->>AI: Analyze Diff (Sanitized + Structured Prompt)
        AI-->>API: Markdown Summary + Suggested README
        API->>GH: Post Review Comment on PR
        opt autoCommitReadme is true & README updates suggested
            API->>GH: Commit updated README.md to PR branch
        end
        API->>DB: Update WebhookLog (Status: SUCCESS, Comment URL)
    end
```

---

## ✨ Key Features

- **🚀 Instant AI Code Review**: Automated code summaries with structured sections, checklists, and impact analysis.
- **📝 Automated README Commits**: Keep your documentation up to date automatically on every structural PR.
- **🛡️ HMAC Signature Verification**: Rejects any unauthenticated or tampered webhook payloads.
- **⚡ Token Optimization & Diff Sanitization**: Automatically strips lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`), build artifacts, and maps to protect token quotas.
- **🌗 Dark Mode Dashboard**: Clean dashboard built with Tailwind CSS, Lucide icons, and responsive layouts.
- **🔑 Bring Your Own Key (BYOK)**: 100% self-hosted readiness using free Google AI Studio keys.

---

## ⚙️ Tech Stack

| Layer | Technology | Description |
| :--- | :--- | :--- |
| **Monorepo** | npm Workspaces | Root orchestrator for `/backend` and `/frontend` |
| **Frontend** | Next.js 14 (App Router) + TypeScript | Modern user portal and repository management dashboard |
| **Styling** | Tailwind CSS + Lucide Icons | Dark mode glassmorphic UI |
| **Backend** | Express + TypeScript (Strict Mode) | Modular MVC architecture with dedicated domain controllers |
| **ORM & DB** | Prisma ORM + PostgreSQL 15 | Type-safe schema models with cascade relations |
| **Authentication** | NextAuth.js (Auth.js) | GitHub OAuth provider with `repo` and `write:repo_hook` scopes |
| **AI Processing** | `@google/generative-ai` | Google Gemini 1.5 Flash integration |
| **GitHub SDK** | `@octokit/rest` | Repository management, webhook subscriptions, and PR commits |
| **Validation** | Zod | Runtime schema validation for environment variables and payloads |

---

## 📁 Monorepo Structure

```text
gitdocs/
├── docker-compose.yml              # Local PostgreSQL 15 container
├── package.json                    # Monorepo root with workspace scripts
├── backend/                        # Express MVC REST API & Webhook Engine
│   ├── prisma/
│   │   └── schema.prisma           # Prisma database models (User, Repository, WebhookLog)
│   ├── src/
│   │   ├── config/                 # Zod validated env and Prisma singleton
│   │   ├── controllers/            # auth.controller, repository.controller, webhook.controller
│   │   ├── middlewares/            # auth.middleware, webhookSignature.middleware
│   │   ├── routes/                 # Feature routes aggregated in routes/index.ts
│   │   ├── services/               # github.service, gemini.service, prProcessor.service
│   │   ├── utils/                  # Standard envelope response helpers
│   │   ├── app.ts                  # Express application setup
│   │   └── server.ts               # Server startup listener
│   └── package.json
└── frontend/                       # Next.js 14 App Router Dashboard
    ├── src/
    │   ├── app/                    # Layout, page.tsx, NextAuth route handlers
    │   ├── components/             # Navbar, RepositoryList, WebhookLogsTable, StatsCards
    │   └── lib/                    # NextAuth options and typed API client
    ├── tailwind.config.js
    └── package.json
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18.18+ or v20+
- **Docker & Docker Compose**: For local PostgreSQL

### 2. Clone and Install Dependencies

```bash
git clone https://github.com/ariellucaslf/gitdocs.git
cd gitdocs
npm install
```

### 3. Start PostgreSQL with Docker

```bash
docker-compose up -d
```

### 4. Configure Environment Variables

#### Backend Configuration (`backend/.env`)
Create `backend/.env` (or copy from `backend/.env.example`):
```env
PORT=4000
DATABASE_URL="postgresql://gitdocs_user:gitdocs_password@localhost:5432/gitdocs_db?schema=public"
GITHUB_CLIENT_ID="your-github-oauth-client-id"
GITHUB_CLIENT_SECRET="your-github-oauth-client-secret"
GITHUB_WEBHOOK_SECRET="your-secure-webhook-secret-phrase"
GEMINI_API_KEY="your-google-gemini-api-key"
```

#### Frontend Configuration (`frontend/.env.local`)
Create `frontend/.env.local` (or copy from `frontend/.env.example`):
```env
NEXT_PUBLIC_API_URL="http://localhost:4000/api"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-random-32-char-secret-string"
GITHUB_CLIENT_ID="your-github-oauth-client-id"
GITHUB_CLIENT_SECRET="your-github-oauth-client-secret"
```

> **How to get credentials:**
> - **Google Gemini API Key**: Free at [Google AI Studio](https://aistudio.google.com/).
> - **GitHub OAuth App**: Go to GitHub > Settings > Developer settings > OAuth Apps > *New OAuth App*.
>   - Homepage URL: `http://localhost:3000`
>   - Authorization callback URL: `http://localhost:3000/api/auth/callback/github`

### 5. Synchronize Database Schema

```bash
npm run db:push
```

### 6. Run the Applications

In separate terminals:

```bash
# Terminal 1 — Backend API (port 4000)
npm run dev:backend

# Terminal 2 — Frontend Dashboard (port 3000)
npm run dev:frontend
```

Open [http://localhost:3000](http://localhost:3000) in your browser!

---

## 🧪 Verification & Type-Checking

Run full monorepo type-checking:

```bash
npm run typecheck
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
