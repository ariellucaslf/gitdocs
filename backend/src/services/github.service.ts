import { Octokit } from '@octokit/rest';
import { env } from '../config/env.js';

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
    return new Octokit({ auth: accessToken });
  }

  async listUserRepositories(accessToken: string): Promise<GitHubRepositoryItem[]> {
    const octokit = this.getOctokit(accessToken);
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({
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
    const { data } = await octokit.request('GET /repositories/:id', { id: repoId });
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
    try {
      const octokit = this.getOctokit(accessToken);
      const { data: hooks } = await octokit.rest.repos.listWebhooks({
        owner,
        repo,
        per_page: 100,
      });

      const matchingHook = hooks.find(
        (h) => h.config && h.config.url && h.config.url.toLowerCase() === webhookUrl.toLowerCase()
      );

      return matchingHook ? matchingHook.id : null;
    } catch (error) {
      console.warn(`Could not list webhooks for ${owner}/${repo}:`, error);
      return null;
    }
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
    try {
      const octokit = this.getOctokit(accessToken);
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
      });

      const matching = comments.find((c) => c.body && c.body.includes(marker));
      return matching ? matching.html_url : null;
    } catch (err) {
      console.warn(`Could not list comments for PR #${pullNumber}:`, err);
      return null;
    }
  }

  async getPullRequestHeadSha(
    accessToken: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<{ headSha: string; state: string } | null> {
    try {
      const octokit = this.getOctokit(accessToken);
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      return {
        headSha: pr.head.sha,
        state: pr.state,
      };
    } catch (err) {
      console.warn(`Could not fetch PR #${pullNumber} head SHA:`, err);
      return null;
    }
  }

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | null> {
    try {
      const octokit = this.getOctokit(accessToken);
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if ('content' in response.data && typeof response.data.content === 'string') {
        const decoded = Buffer.from(response.data.content, 'base64').toString('utf8');
        return {
          content: decoded,
          sha: response.data.sha,
        };
      }
      return null;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error?.status === 404) {
        return null;
      }
      throw err;
    }
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
    try {
      const octokit = this.getOctokit(accessToken);
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const headRepoFullName = pr.head.repo ? pr.head.repo.full_name : `${owner}/${repo}`;
      const baseRepoFullName = pr.base.repo ? pr.base.repo.full_name : `${owner}/${repo}`;
      const isFork = headRepoFullName.toLowerCase() !== baseRepoFullName.toLowerCase();

      return {
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        state: pr.state,
        isFork,
        headRepoFullName,
        baseRepoFullName,
      };
    } catch (err) {
      console.warn(`Could not fetch PR #${pullNumber} details:`, err);
      return null;
    }
  }

  async createDocCommit(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    parentCommitSha: string,
    filePath: string,
    content: string,
    commitMessage: string
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
