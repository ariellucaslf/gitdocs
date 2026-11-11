import crypto from 'node:crypto';

export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

export const userA = {
  id: 'user-uuid-aaa-111',
  githubId: 100001,
  username: 'alice-developer',
  email: 'alice@example.com',
  avatarUrl: 'https://example.com/avatar/alice.png',
  accessToken: 'gho_fake_token_alice_1234567890',
};

export const userB = {
  id: 'user-uuid-bbb-222',
  githubId: 200002,
  username: 'bob-maintainer',
  email: 'bob@example.com',
  avatarUrl: 'https://example.com/avatar/bob.png',
  accessToken: 'gho_fake_token_bob_0987654321',
};

export const repoA = {
  id: 'repo-uuid-aaa-101',
  githubRepoId: 900001,
  name: 'alice-project',
  fullName: 'alice-developer/alice-project',
  owner: 'alice-developer',
  isActive: true,
  desiredActive: true,
  provisioningState: 'ACTIVE' as const,
  lastErrorCode: null,
  autoCommitReadme: false,
  webhookId: 555001,
  userId: userA.id,
};

export const repoB = {
  id: 'repo-uuid-bbb-202',
  githubRepoId: 900002,
  name: 'bob-project',
  fullName: 'bob-maintainer/bob-project',
  owner: 'bob-maintainer',
  isActive: false,
  desiredActive: false,
  provisioningState: 'DISABLED' as const,
  lastErrorCode: null,
  autoCommitReadme: false,
  webhookId: null,
  userId: userB.id,
};

export interface PullRequestPayloadOptions {
  action?: 'opened' | 'synchronize' | 'reopened' | 'closed';
  repoId?: number;
  repoFullName?: string;
  repoName?: string;
  repoOwner?: string;
  prNumber?: number;
  prTitle?: string;
  headSha?: string;
  baseRef?: string;
}

export function createPullRequestWebhookPayload(options: PullRequestPayloadOptions = {}) {
  const {
    action = 'opened',
    repoId = repoA.githubRepoId,
    repoFullName = repoA.fullName,
    repoName = repoA.name,
    repoOwner = repoA.owner,
    prNumber = 42,
    prTitle = 'feat: add user authentication',
    headSha = 'abcdef1234567890abcdef1234567890abcdef12',
    baseRef = 'main',
  } = options;

  return {
    action,
    number: prNumber,
    pull_request: {
      number: prNumber,
      title: prTitle,
      body: 'Implemented authentication flow and tests.',
      head: {
        sha: headSha,
        ref: 'feat/auth',
      },
      base: {
        ref: baseRef,
      },
    },
    repository: {
      id: repoId,
      name: repoName,
      full_name: repoFullName,
      owner: {
        login: repoOwner,
      },
    },
    sender: {
      login: 'contributor',
      id: 300003,
    },
  };
}

export function signPayload(payload: string | Buffer | object, secret: string = TEST_WEBHOOK_SECRET): string {
  const buffer =
    Buffer.isBuffer(payload)
      ? payload
      : typeof payload === 'string'
      ? Buffer.from(payload)
      : Buffer.from(JSON.stringify(payload));
  const hmac = crypto.createHmac('sha256', secret);
  return `sha256=${hmac.update(buffer).digest('hex')}`;
}
