import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/prisma.js';
import { githubService } from '../../src/services/github.service.js';
import { geminiService } from '../../src/services/gemini.service.js';
import { queueService } from '../../src/worker/queue.service.js';
import { jobProcessorService } from '../../src/worker/processor.service.js';
import { repoA, userA } from '../fixtures/index.js';
vi.mock('../../src/config/prisma.js', () => ({ prisma: { processingRun: { updateMany: vi.fn() }, repository: { findUnique: vi.fn() }, $transaction: vi.fn() } }));
vi.mock('../../src/services/github.service.js', () => ({ githubService: { getPullRequestDetails: vi.fn(), postPullRequestComment: vi.fn() } }));
vi.mock('../../src/services/gemini.service.js', () => ({ geminiService: { analyzePullRequest: vi.fn() } }));
const run = { id: 'run', repositoryId: repoA.id, headSha: 'a'.repeat(40), leaseVersion: 2, attemptCount: 1, maxAttempts: 3 } as any;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(prisma.processingRun.updateMany).mockResolvedValue({ count: 1 }); });
describe('Worker stops before external effects', () => {
  it('a worker without a current lease cannot publish or change final status', async () => {
    vi.spyOn(queueService, 'renewLease').mockResolvedValueOnce(false);
    await jobProcessorService.processRun(run, 'old-worker');
    expect(githubService.postPullRequestComment).not.toHaveBeenCalled(); expect(prisma.processingRun.updateMany).toHaveBeenCalledTimes(1); // release only
  });
  it('a disabled repository is skipped before calling GitHub or AI', async () => {
    vi.spyOn(queueService, 'renewLease').mockResolvedValueOnce(true);
    vi.mocked(prisma.repository.findUnique).mockResolvedValue({ ...repoA, isActive: false, user: userA } as any);
    await jobProcessorService.processRun(run, 'worker');
    expect(githubService.getPullRequestDetails).not.toHaveBeenCalled(); expect(geminiService.analyzePullRequest).not.toHaveBeenCalled();
    expect(prisma.processingRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SKIPPED', lastErrorCode: 'MONITORING_DISABLED' } }));
  });
  it('a superseded head cannot be analyzed or published', async () => {
    vi.spyOn(queueService, 'renewLease').mockResolvedValueOnce(true);
    vi.mocked(prisma.repository.findUnique).mockResolvedValue({ ...repoA, user: userA } as any);
    vi.mocked(githubService.getPullRequestDetails).mockResolvedValue({ state: 'open', headSha: 'b'.repeat(40) } as any);
    await jobProcessorService.processRun(run, 'worker');
    expect(geminiService.analyzePullRequest).not.toHaveBeenCalled(); expect(githubService.postPullRequestComment).not.toHaveBeenCalled();
  });
});
