import { Octokit } from '@octokit/rest';
import { env } from '../config/env.js';
import { isUtf8 } from 'node:buffer';

export interface GitHubRepositoryItem {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
}

export class GitHubService {
  private getOctokit(accessToken: string): Octokit {
    return new Octokit({ auth: accessToken, request: { timeout: 20000 } });
  }

  async getAuthenticatedUser(accessToken: string) {
    const { data } = await this.getOctokit(accessToken).rest.users.getAuthenticated();
    return data;
  }

  async listUserRepositories(accessToken: string): Promise<GitHubRepositoryItem[]> {
    const octokit = this.getOctokit(accessToken);
    const data = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      affiliation: 'owner,collaborator,organization_member',
    });

    return data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      private: repo.private,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      description: repo.description,
    }));
  }

  async getRepositoryById(
    accessToken: string,
    repoId: number
  ): Promise<{
    id: number;
    name: string;
    fullName: string;
    owner: string;
    permissions?: {
      admin?: boolean;
      push?: boolean;
      pull?: boolean;
    };
  }> {
    const octokit = this.getOctokit(accessToken);
    const { data } = await octokit.request('GET /repositories/{repository_id}', { repository_id: repoId });
    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      owner: data.owner.login,
      permissions: data.permissions,
    };
  }

  async findRepositoryWebhook(
    accessToken: string,
    owner: string,
    repo: string,
    webhookUrl: string
  ): Promise<number | null> {
    const octokit = this.getOctokit(accessToken);
    const hooks = await octokit.paginate(octokit.rest.repos.listWebhooks, { owner, repo, per_page: 100 });
    const matches = hooks.filter(hook => hook.config?.url === webhookUrl);
    if (matches.length > 1) throw new Error('AMBIGUOUS_WEBHOOK_CONFIGURATION');
    return matches[0]?.id ?? null;
  }

  async createRepositoryWebhook(
    accessToken: string,
    owner: string,
    repo: string,
    webhookUrl: string
  ): Promise<number> {
    // Reconcile: Check if webhook already exists before attempting creation
    const existingHookId = await this.findRepositoryWebhook(accessToken, owner, repo, webhookUrl);
    if (existingHookId) {
      // Reconfirm active state, event subscription, and current HMAC secret.
      await this.getOctokit(accessToken).rest.repos.updateWebhook({
        owner, repo, hook_id: existingHookId, active: true, events: ['pull_request'],
        config: { url: webhookUrl, content_type: 'json', secret: env.GITHUB_WEBHOOK_SECRET, insecure_ssl: '0' },
      });
      return existingHookId;
    }

    const octokit = this.getOctokit(accessToken);
    const { data } = await octokit.rest.repos.createWebhook({
      owner,
      repo,
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: env.GITHUB_WEBHOOK_SECRET || undefined,
        insecure_ssl: '0',
      },
    });

    return data.id;
  }

  async deleteRepositoryWebhook(
    accessToken: string,
    owner: string,
    repo: string,
    webhookId: number
  ): Promise<void> {
    const octokit = this.getOctokit(accessToken);
    try {
      await octokit.rest.repos.deleteWebhook({
        owner,
        repo,
        hook_id: webhookId,
      });
    } catch (error: unknown) {
      // If hook was already deleted on GitHub (404), consider it reconciled
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async getPullRequestDiff(
    accessToken: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<string> {
    const octokit = this.getOctokit(accessToken);
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: 'diff',
      },
    });

    // In Octokit with mediaType 'diff', data is returned as string
    return response.data as unknown as string;
  }

  async postPullRequestComment(
    accessToken: string,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<string> {
    const octokit = this.getOctokit(accessToken);
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });

    return data.html_url;
  }

  async findPullRequestComment(
    accessToken: string,
    owner: string,
    repo: string,
    pullNumber: number,
    marker: string
  ): Promise<string | null> {
    const octokit = this.getOctokit(accessToken);
    const [{ data: user }, comments] = await Promise.all([
      octokit.rest.users.getAuthenticated(),
      octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 }),
    ]);
    const matching = comments.find(comment => comment.user?.id === user.id && comment.body?.includes(marker));
    return matching?.html_url ?? null;
  }

  async getPullRequestHeadSha(
    accessToken: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<{ headSha: string; state: string } | null> {
    const details = await this.getPullRequestDetails(accessToken, owner, repo, pullNumber);
    return details ? { headSha: details.headSha, state: details.state } : null;
  }

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | null> {
    if (path !== 'README.md') throw new Error('INVALID_TARGET_PATH');
    const octokit = this.getOctokit(accessToken);
    const { data: commit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: ref });
    const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: commit.tree.sha });
    const entry = tree.tree.find(item => item.path === path);
    if (!entry) return null;
    if (entry.mode !== '100644' || entry.type !== 'blob' || (entry.size ?? 0) > 65536) throw new Error('UNSUPPORTED_README_FILE');
    const { data: blob } = await octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha! });
    if (blob.encoding !== 'base64') throw new Error('UNSUPPORTED_README_ENCODING');
    const bytes = Buffer.from(blob.content, 'base64');
    if (bytes.length > 65536 || !isUtf8(bytes) || bytes.includes(0)) throw new Error('UNSUPPORTED_README_CONTENT');
    return { content: bytes.toString('utf8'), sha: entry.sha! };
  }

  async getPullRequestDetails(
    accessToken: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<{
    headSha: string;
    headRef: string;
    baseRef: string;
    state: string;
    isFork: boolean;
    headRepoFullName: string;
    baseRepoFullName: string;
  } | null> {
    const { data: pr } = await this.getOctokit(accessToken).rest.pulls.get({ owner, repo, pull_number: pullNumber });
    return {
      headSha: pr.head.sha, headRef: pr.head.ref, baseRef: pr.base.ref, state: pr.state,
      isFork: !pr.head.repo || pr.head.repo.id !== pr.base.repo.id,
      headRepoFullName: pr.head.repo?.full_name ?? '', baseRepoFullName: pr.base.repo.full_name,
    };
  }

  async verifyDocCommit(accessToken: string, owner: string, repo: string, sha: string,
    intent: { id: string; expectedParentSha: string; expectedContentHash: string; preparedCommitSha?: string | null }): Promise<boolean> {
    const { data: commit } = await this.getOctokit(accessToken).rest.git.getCommit({ owner, repo, commit_sha: sha });
    if (commit.parents.length !== 1 || commit.parents[0]?.sha !== intent.expectedParentSha) return false;
    if (!commit.message.includes(`Intent-ID: ${intent.id}`)) return false;
    if (intent.preparedCommitSha && intent.preparedCommitSha !== sha) return false;
    const file = await this.getFileContent(accessToken, owner, repo, 'README.md', sha);
    const { createHash } = await import('node:crypto');
    return !!file && createHash('sha256').update(file.content).digest('hex') === intent.expectedContentHash;
  }

  async publishPreparedCommit(accessToken: string, owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.getOctokit(accessToken).rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha, force: false });
  }

  async isCommitInHistory(accessToken: string, owner: string, repo: string, ancestor: string, head: string): Promise<boolean> {
    if (ancestor === head) return true;
    const { data } = await this.getOctokit(accessToken).rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${ancestor}...${head}` });
    return data.merge_base_commit.sha === ancestor && ['ahead', 'identical'].includes(data.status);
  }

  async createDocCommit(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    parentCommitSha: string,
    filePath: string,
    content: string,
    commitMessage: string,
    onPrepared?: (sha: string) => Promise<void>
  ): Promise<{ commitSha: string; commitUrl: string }> {
    const octokit = this.getOctokit(accessToken);

    // 1. Retrieve parent commit to determine base tree
    const { data: parentCommit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: parentCommitSha,
    });

    const baseTreeSha = parentCommit.tree.sha;

    // 2. Create Git Blob
    const { data: blob } = await octokit.rest.git.createBlob({
      owner,
      repo,
      content,
      encoding: 'utf-8',
    });

    // 3. Create Git Tree on top of baseTreeSha
    const { data: tree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: [
        {
          path: filePath,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        },
      ],
    });

    // 4. Create Git Commit pointing to parentCommitSha
    const { data: commit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: tree.sha,
      parents: [parentCommitSha],
    });

    // Persist the exact commit before publishing. An ambiguous update can then be reconciled.
    if (onPrepared) await onPrepared(commit.sha);

    // 5. Update branch ref without force (fails if branch moved, ensuring safe non-force update)
    const cleanBranch = branch.replace(/^refs\/heads\//, '');
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${cleanBranch}`,
      sha: commit.sha,
      force: false,
    });

    return {
      commitSha: commit.sha,
      commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    };
  }

  async commitFileToBranch(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: string,
    commitMessage: string
  ): Promise<{ commitUrl: string }> {
    const octokit = this.getOctokit(accessToken);
    let sha: string | undefined;

    try {
      const existingFile = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: branch,
      });

      if ('sha' in existingFile.data) {
        sha = existingFile.data.sha;
      }
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status !== 404) {
        console.warn(`⚠️ Warning fetching existing file ${path}:`, error);
      }
    }

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: commitMessage,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch,
      sha,
    });

    return {
      commitUrl: data.commit.html_url || '',
    };
  }
}

export const githubService = new GitHubService();
