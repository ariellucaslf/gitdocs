const BFF_BASE_URL = '/api/bff';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error: string | null;
}

export interface RepositoryItem {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
  dbId: string | null;
  isActive: boolean;
  autoCommitReadme: boolean;
  webhookId: number | null;
}

export interface WebhookLogItem {
  id: string;
  repositoryId: string;
  prNumber: number;
  prTitle: string;
  status: 'PENDING' | 'SUCCESS' | 'ERROR';
  rawDiffSize: number;
  errorMessage: string | null;
  responseCommentUrl: string | null;
  createdAt: string;
  repository: {
    name: string;
    fullName: string;
    owner: string;
  };
}

export interface ToggleRepoPayload {
  githubRepoId: number;
  isActive: boolean;
  name?: string;
  fullName?: string;
  owner?: string;
  autoCommitReadme?: boolean;
}

export async function fetchRepositories(_token?: string): Promise<RepositoryItem[]> {
  const res = await fetch(`${BFF_BASE_URL}/repositories`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch repositories: ${res.statusText}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Failed to fetch repositories');
  }

  return Array.isArray(json.data) ? json.data : json.data.items || [];
}

export async function toggleRepository(
  tokenOrPayload: string | ToggleRepoPayload,
  optionalPayload?: ToggleRepoPayload
): Promise<void> {
  const payload = (typeof tokenOrPayload === 'string' ? optionalPayload : tokenOrPayload) as ToggleRepoPayload;

  const res = await fetch(`${BFF_BASE_URL}/repositories/toggle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to toggle repository: ${res.statusText}`);
  }

  const json: ApiResponse<unknown> = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Failed to toggle repository');
  }
}

export async function fetchWebhookLogs(_token?: string): Promise<WebhookLogItem[]> {
  const res = await fetch(`${BFF_BASE_URL}/webhooks/logs`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch logs: ${res.statusText}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Failed to fetch logs');
  }

  return Array.isArray(json.data) ? json.data : json.data.items || [];
}
