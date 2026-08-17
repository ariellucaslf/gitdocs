import { prisma } from '../config/prisma.js';
import { githubService } from './github.service.js';
import { geminiService } from './gemini.service.js';

export interface PullRequestPayloadData {
  number: number;
  title: string;
  body: string | null;
  head: {
    ref: string;
    sha: string;
    repo: {
      name: string;
      owner: {
        login: string;
      };
    };
  };
}

export interface RepositoryPayloadData {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
}

export class PRProcessorService {
  async processPullRequest(
    logId: string,
    repositoryId: string,
    pullRequest: PullRequestPayloadData,
    repository: RepositoryPayloadData
  ): Promise<void> {
    try {
      console.log(`⚡ [PRProcessor] Starting background processing for PR #${pullRequest.number} on ${repository.full_name}`);

      // 1. Retrieve repository record with associated user token
      const dbRepo = await prisma.repository.findUnique({
        where: { id: repositoryId },
        include: { user: true },
      });

      if (!dbRepo || !dbRepo.user || !dbRepo.user.accessToken) {
        throw new Error(`Repository or user authentication not found for repository ID: ${repositoryId}`);
      }

      const accessToken = dbRepo.user.accessToken;
      const owner = repository.owner.login;
      const repoName = repository.name;
      const prNumber = pullRequest.number;

      // 2. Fetch raw PR diff from GitHub
      const rawDiff = await githubService.getPullRequestDiff(accessToken, owner, repoName, prNumber);
      const rawDiffSize = Buffer.byteLength(rawDiff, 'utf8');

      // Update log with diff size
      await prisma.webhookLog.update({
        where: { id: logId },
        data: { rawDiffSize },
      });

      // 3. Run AI review with Google Gemini
      const analysis = await geminiService.analyzePullRequest(
        pullRequest.title,
        pullRequest.body,
        rawDiff
      );

      // 4. Post AI review comment on the Pull Request
      const commentUrl = await githubService.postPullRequestComment(
        accessToken,
        owner,
        repoName,
        prNumber,
        analysis.summaryMarkdown
      );

      console.log(`💬 [PRProcessor] Comment posted to PR #${prNumber}: ${commentUrl}`);

      // 5. Handle automatic README commit if enabled and structural changes detected
      if (dbRepo.autoCommitReadme && analysis.suggestedReadmeUpdate) {
        try {
          const branch = pullRequest.head.ref;
          const headOwner = pullRequest.head.repo?.owner?.login || owner;
          const headRepo = pullRequest.head.repo?.name || repoName;

          console.log(`📝 [PRProcessor] Autocommitting suggested README updates to branch '${branch}'...`);

          await githubService.commitFileToBranch(
            accessToken,
            headOwner,
            headRepo,
            branch,
            'README.md',
            analysis.suggestedReadmeUpdate,
            `docs: auto-update README.md from PR #${prNumber} review [skip ci]`
          );

          console.log(`✅ [PRProcessor] README.md committed successfully to branch ${branch}`);
        } catch (commitErr) {
          console.error(`⚠️ [PRProcessor] Failed to autocommit README.md:`, commitErr);
        }
      }

      // 6. Update WebhookLog to SUCCESS
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'SUCCESS',
          responseCommentUrl: commentUrl,
        },
      });

      console.log(`✨ [PRProcessor] Completed PR #${prNumber} processing successfully.`);
    } catch (error) {
      console.error(`❌ [PRProcessor] Error processing PR #${pullRequest.number}:`, error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error during PR processing';

      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'ERROR',
          errorMessage,
        },
      }).catch((dbErr) => console.error('Failed to update error status on WebhookLog:', dbErr));
    }
  }
}

export const prProcessorService = new PRProcessorService();
