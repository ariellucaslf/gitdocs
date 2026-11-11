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
  provisioningState?: 'DISABLED' | 'PROVISIONING' | 'ACTIVE' | 'ERROR';
  desiredActive?: boolean;
  lastErrorCode?: string | null;
}

export interface WebhookLogItem {
  id: string;
  repositoryId: string;
  prNumber: number;
  prTitle: string;
  status: 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCESS' | 'PARTIAL_SUCCESS' | 'ERROR' | 'SKIPPED' | 'SUPERSEDED';
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

export interface PageData<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  aggregates: Record<string, number | string>;
}

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BFF_BASE_URL}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || `Request failed (${res.status})`);
  return json.data;
}
export function fetchRepositories(page = 1): Promise<PageData<RepositoryItem>> {
  return api(`repositories?page=${page}&limit=24`);
}
export function fetchWebhookLogs(page = 1): Promise<PageData<WebhookLogItem>> {
  return api(`webhooks/logs?page=${page}&limit=25`);
}
export function toggleRepository(payload: ToggleRepoPayload): Promise<void> { return api('repositories/toggle', payload); }
export interface DocProposal {
  id: string; prNumber: number; title: string; description?: string; headSha: string; previewContent: string;
  operations: { oldText: string; newText: string }[]; isFork: boolean;
  status: 'PENDING_APPROVAL' | 'APPLYING' | 'APPLIED' | 'REJECTED' | 'STALE' | 'FAILED';
  failureReason?: string; commitUrl?: string;
}
export function fetchProposals(repositoryId: string): Promise<DocProposal[]> { return api(`repositories/${repositoryId}/proposals`); }
export function actOnProposal(id: string, action: 'approve' | 'reject'): Promise<unknown> { return api(`proposals/${id}/${action}`, {}); }
