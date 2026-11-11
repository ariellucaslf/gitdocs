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

      // 5. Direct README autocommit is suspended to prevent data loss (ADR 0003).
      // Suggested documentation updates must go through contextual proposal and human review.
      if (dbRepo.autoCommitReadme && analysis.suggestedReadmeUpdate) {
        console.warn(
          `🛡️ [PRProcessor] Direct README autocommit blocked for PR #${prNumber} (repository: ${repository.full_name}). ` +
            `Automated writes without human approval are disabled to prevent data loss.`
        );
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
      }).catch((dbErr: unknown) => console.error('Failed to update error status on WebhookLog:', dbErr));
    }
  }
}

export const prProcessorService = new PRProcessorService();
