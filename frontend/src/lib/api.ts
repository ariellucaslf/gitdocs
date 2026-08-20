const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

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
  name: string;
  fullName: string;
  owner: string;
  isActive: boolean;
  autoCommitReadme: boolean;
  webhookUrl?: string;
}

export async function fetchRepositories(token: string): Promise<RepositoryItem[]> {
  const res = await fetch(`${API_BASE_URL}/repositories`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch repositories: ${res.statusText}`);
  }

  const json: ApiResponse<RepositoryItem[]> = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Failed to fetch repositories');
  }

  return json.data;
}

export async function toggleRepository(
  token: string,
  payload: ToggleRepoPayload
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/repositories/toggle`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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

export async function fetchWebhookLogs(token: string): Promise<WebhookLogItem[]> {
  const res = await fetch(`${API_BASE_URL}/webhooks/logs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch logs: ${res.statusText}`);
  }

  const json: ApiResponse<WebhookLogItem[]> = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Failed to fetch logs');
  }

  return json.data;
}
