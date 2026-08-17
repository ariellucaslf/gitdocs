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

  async createRepositoryWebhook(
    accessToken: string,
    owner: string,
    repo: string,
    webhookUrl: string
  ): Promise<number> {
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
    await octokit.rest.repos.deleteWebhook({
      owner,
      repo,
      hook_id: webhookId,
    });
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
