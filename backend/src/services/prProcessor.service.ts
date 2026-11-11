import { prisma } from '../config/prisma.js';
import { githubService } from './github.service.js';
import { geminiService } from './gemini.service.js';
import { formatReviewComment } from '../utils/commentFormatter.js';

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

      // Handle skipped analysis (e.g. diff was empty after sanitization)
      if (analysis.kind === 'skipped') {
        console.log(`⏭️ [PRProcessor] PR #${prNumber} analysis skipped (reason: ${analysis.reason}).`);
        await prisma.webhookLog.update({
          where: { id: logId },
          data: {
            status: 'SUCCESS',
            errorMessage: `Skipped: ${analysis.reason}`,
          },
        });
        return;
      }

      // Handle AI failure explicitly: must NEVER be marked as SUCCESS (ADR 0005, V09)
      if (analysis.kind === 'failed') {
        console.error(`❌ [PRProcessor] PR #${prNumber} AI analysis failed: [${analysis.code}] ${analysis.message}`);
        await prisma.webhookLog.update({
          where: { id: logId },
          data: {
            status: 'ERROR',
            errorMessage: `AI_${analysis.code}: ${analysis.message}`,
          },
        });
        return;
      }

      // 4. Deterministically format review comment from validated structured schema
      const commentMarkdown = formatReviewComment({
        analysis: analysis.data,
        usage: analysis.usage,
        truncated: analysis.truncated,
      });

      // 5. Post review comment on the Pull Request
      const commentUrl = await githubService.postPullRequestComment(
        accessToken,
        owner,
        repoName,
        prNumber,
        commentMarkdown
      );

      console.log(`💬 [PRProcessor] Comment posted to PR #${prNumber}: ${commentUrl}`);

      // 6. Direct README autocommit remains suspended to prevent data loss (ADR 0003)
      if (dbRepo.autoCommitReadme && analysis.data.suggestedDocUpdate) {
        console.warn(
          `🛡️ [PRProcessor] Direct README autocommit blocked for PR #${prNumber} (repository: ${repository.full_name}). ` +
            `Documentation proposals require human review before applying.`
        );
      }

      // 7. Update WebhookLog to SUCCESS only when analysis and comment succeed
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
