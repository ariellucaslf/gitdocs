import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { prisma } from '../../src/config/prisma.js';
import { migrateCredentials } from '../../src/scripts/migrateCredentials.js';
import { app } from '../../src/app.js';
import { cryptoService } from '../../src/services/crypto.service.js';
import { githubService } from '../../src/services/github.service.js';
import { geminiService } from '../../src/services/gemini.service.js';
import { docProposalService } from '../../src/services/docProposal.service.js';
import { repositoryProvisioningService } from '../../src/services/repositoryProvisioning.service.js';
import { queueService } from '../../src/worker/queue.service.js';
import { jobProcessorService } from '../../src/worker/processor.service.js';
import { createPullRequestWebhookPayload, signPayload } from '../fixtures/index.js';

const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const original = '# Project\n\nInstall: old\n\n## License\nMIT\n';
let userId: string, otherId: string, repoId: string, ghId: number;
const details = { headSha: sha, headRef: 'feature', baseRef: 'main', state: 'open', isFork: false, headRepoFullName: 'owner/project', baseRepoFullName: 'owner/project' };
const analysis = { kind: 'analyzed' as const, data: { schemaVersion: 1 as const, summary: 'Review', categories: ['feat' as const], findings: [], suggestedDocUpdate: null }, usage: null, truncated: false };
async function newRun(overrides = {}) {
  return prisma.processingRun.create({ data: { repositoryId: repoId, prNumber: 42, prTitle: 'Change', headSha: sha, availableAt: new Date(0), ...overrides } });
}
async function proposal() {
  return docProposalService.createProposal({ repositoryId: repoId, prNumber: 42, headSha: sha, title: 'Update setup',
    operations: [{ oldText: 'Install: old', newText: 'Install: new' }], originalFileContent: original });
}
function assertion(id: string) { return cryptoService.signInternalAssertion({ userId: id, githubId: id === userId ? ghId : ghId + 1, username: 'owner' }); }
async function webhook(delivery: string, payload: object) {
  const raw = JSON.stringify(payload);
  return request(app).post('/api/webhooks').set('x-github-event', 'pull_request').set('x-github-delivery', delivery)
    .set('x-hub-signature-256', signPayload(raw)).set('Content-Type', 'application/json').send(raw);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  ghId = 1000000 + crypto.randomInt(100000000);
  const encrypted = cryptoService.encryptToken('gho_integration_fake_token');
  const data = { username: 'owner', accessToken: '', encryptedToken: encrypted.ciphertext, tokenIv: encrypted.iv, tokenTag: encrypted.tag, tokenKeyVersion: encrypted.keyVersion };
  const user = await prisma.user.create({ data: { ...data, githubId: ghId } }); userId = user.id;
  const other = await prisma.user.create({ data: { ...data, githubId: ghId + 1 } }); otherId = other.id;
  const repo = await prisma.repository.create({ data: { userId, githubRepoId: ghId, name: 'project', owner: 'owner', fullName: 'owner/project', isActive: true, desiredActive: true, provisioningState: 'ACTIVE', webhookId: 123 } }); repoId = repo.id;
  vi.spyOn(githubService, 'getRepositoryById').mockResolvedValue({ id: ghId, name: 'project', owner: 'owner', fullName: 'owner/project', permissions: { admin: true, push: true } });
  vi.spyOn(githubService, 'getPullRequestDetails').mockResolvedValue(details);
  vi.spyOn(githubService, 'getPullRequestDiff').mockResolvedValue('diff --git a/app.ts b/app.ts\n+const a = 1;');
  vi.spyOn(githubService, 'getFileContent').mockResolvedValue({ content: original, sha });
  vi.spyOn(githubService, 'findPullRequestComment').mockResolvedValue(null);
  vi.spyOn(githubService, 'postPullRequestComment').mockResolvedValue('https://github.com/owner/project/pull/42#issuecomment-1');
  vi.spyOn(geminiService, 'analyzePullRequest').mockResolvedValue(analysis);
});
afterEach(async () => { await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); });
afterAll(async () => { await prisma.$disconnect(); });

describe('Persisted admission and recovery', () => {
  it('commits concurrent identical deliveries atomically and never runs AI in the receiver', async () => {
    const payload = createPullRequestWebhookPayload({ repoId: ghId, headSha: sha });
    const id = crypto.randomUUID();
    const results = await Promise.all([webhook(id, payload), webhook(id, payload)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 202]);
    expect(await prisma.processingRun.count({ where: { repositoryId: repoId } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { repositoryId: repoId } })).toBe(1);
    expect(geminiService.analyzePullRequest).not.toHaveBeenCalled();
    expect(githubService.postPullRequestComment).not.toHaveBeenCalled();
  });
  it('deduplicates different deliveries for the same revision and rejects changed digests', async () => {
    const payload = createPullRequestWebhookPayload({ repoId: ghId, headSha: sha });
    const id = crypto.randomUUID();
    expect((await webhook(id, payload)).status).toBe(202);
    expect((await webhook(crypto.randomUUID(), payload)).status).toBe(202);
    expect((await webhook(id, { ...payload, action: 'reopened' })).status).toBe(409);
    expect(await prisma.processingRun.count({ where: { repositoryId: repoId } })).toBe(1);
  });
  it('does not suppress a human commit just because an unrelated intent is pending', async () => {
    const prop = await proposal();
    await prisma.commitIntent.create({ data: { proposalId: prop.id, repositoryId: repoId, prNumber: 42, expectedParentSha: nextSha, expectedContentHash: 'unused' } });
    expect((await webhook(crypto.randomUUID(), createPullRequestWebhookPayload({ repoId: ghId, headSha: sha, action: 'synchronize' }))).status).toBe(202);
  });
  it('suppresses a prepared commit only after verifying parent and content on GitHub', async () => {
    const prop = await proposal();
    await prisma.commitIntent.create({ data: { proposalId: prop.id, repositoryId: repoId, prNumber: 42, expectedParentSha: nextSha, expectedContentHash: 'hash', preparedCommitSha: sha } });
    vi.spyOn(githubService, 'verifyDocCommit').mockResolvedValue(true);
    const response = await webhook(crypto.randomUUID(), createPullRequestWebhookPayload({ repoId: ghId, headSha: sha, action: 'synchronize' }));
    expect(response.status).toBe(200); expect(response.body.data.skipped).toBe(true);
    expect((await prisma.docProposal.findUniqueOrThrow({ where: { id: prop.id } })).status).toBe('APPLIED');
  });
  it('gives one worker an exclusive lease and fences a dead worker after recovery', async () => {
    await newRun();
    const reservations = await Promise.all([queueService.reserveNextJob('worker-a'), queueService.reserveNextJob('worker-b')]);
    const active = reservations.find(Boolean)!;
    expect(reservations.filter(Boolean)).toHaveLength(1);
    await prisma.processingRun.update({ where: { id: active.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const recovered = await queueService.reserveNextJob('replacement');
    expect(recovered?.id).toBe(active.id); expect(recovered!.leaseVersion).toBeGreaterThan(active.leaseVersion);
    expect(await queueService.renewLease(active.id, active.leaseOwner!, active.leaseVersion)).toBe(false);
    await queueService.releaseLease(active.id, active.leaseOwner!, active.leaseVersion);
    expect((await prisma.processingRun.findUniqueOrThrow({ where: { id: active.id } })).leaseOwner).toBe('replacement');
  });
  it('finishes recovered runs using stored analysis and reconciles comments instead of repeating effects', async () => {
    await newRun({ analysisResult: analysis });
    vi.mocked(githubService.findPullRequestComment).mockResolvedValue('https://github.com/existing');
    const run = await queueService.reserveNextJob('recovery');
    await jobProcessorService.processRun(run!, 'recovery');
    const result = await prisma.processingRun.findUniqueOrThrow({ where: { id: run!.id } });
    expect(result.status).toBe('SUCCESS'); expect(geminiService.analyzePullRequest).not.toHaveBeenCalled();
    expect(githubService.postPullRequestComment).not.toHaveBeenCalled();
    expect(githubService.findPullRequestComment).toHaveBeenCalledWith(expect.any(String), 'owner', 'project', 42, `<!-- gitdocs-run:${run!.id} -->`);
  });
  it('reconciles a comment accepted by GitHub before a network timeout on publication', async () => {
    await newRun();
    vi.mocked(githubService.postPullRequestComment).mockRejectedValueOnce(new Error('timeout after create'));
    const first = await queueService.reserveNextJob('worker'); await jobProcessorService.processRun(first!, 'worker');
    const waiting = await prisma.processingRun.findUniqueOrThrow({ where: { id: first!.id } }); expect(waiting.status).toBe('RETRY_WAIT');
    await prisma.processingRun.update({ where: { id: first!.id }, data: { availableAt: new Date(0) } });
    vi.mocked(githubService.findPullRequestComment).mockResolvedValue('https://github.com/reconciled');
    const second = await queueService.reserveNextJob('worker'); await jobProcessorService.processRun(second!, 'worker');
    expect((await prisma.processingRun.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('SUCCESS');
    expect(geminiService.analyzePullRequest).toHaveBeenCalledTimes(1); expect(githubService.postPullRequestComment).toHaveBeenCalledTimes(1);
  });
  it('does not publish after head advances during analysis', async () => {
    await newRun();
    vi.mocked(geminiService.analyzePullRequest).mockImplementationOnce(async () => {
      vi.mocked(githubService.getPullRequestDetails).mockResolvedValue({ ...details, headSha: nextSha }); return analysis;
    });
    const run = await queueService.reserveNextJob('worker'); await jobProcessorService.processRun(run!, 'worker');
    expect((await prisma.processingRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe('SUPERSEDED');
    expect(githubService.postPullRequestComment).not.toHaveBeenCalled();
  });
  it('marks empty diff skipped and exhausted leases as errors', async () => {
    await newRun(); vi.mocked(geminiService.analyzePullRequest).mockResolvedValue({ kind: 'skipped', reason: 'EMPTY_DIFF' });
    const run = await queueService.reserveNextJob('worker'); await jobProcessorService.processRun(run!, 'worker');
    expect((await prisma.processingRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe('SKIPPED');
    const exhausted = await newRun({ headSha: nextSha, status: 'RUNNING', attemptCount: 3, leaseUntil: new Date(0) });
    expect(await queueService.reserveNextJob('worker')).toBeNull();
    expect((await prisma.processingRun.findUniqueOrThrow({ where: { id: exhausted.id } })).status).toBe('ERROR');
  });
});

describe('Proposal authorization and commit reconciliation', () => {
  it('isolates GET, list, approve and reject across owners without locking or exposing content', async () => {
    const prop = await proposal();
    for (const path of [`/api/proposals/${prop.id}`, `/api/repositories/${repoId}/proposals`]) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${assertion(otherId)}`); expect(res.status).toBe(404);
    }
    for (const action of ['approve', 'reject']) {
      const res = await request(app).post(`/api/proposals/${prop.id}/${action}`).set('Authorization', `Bearer ${assertion(otherId)}`).send({}); expect(res.status).toBe(404);
    }
    expect((await prisma.docProposal.findUniqueOrThrow({ where: { id: prop.id } })).status).toBe('PENDING_APPROVAL');
    expect(githubService.getRepositoryById).not.toHaveBeenCalled();
  });
  it('allows exactly one concurrent approval, preserves unchanged sections and records approval before commit', async () => {
    const prop = await proposal();
    const commit = vi.spyOn(githubService, 'createDocCommit').mockImplementation(async (...args) => {
      const row = await prisma.docProposal.findUniqueOrThrow({ where: { id: prop.id } }); expect(row.approvedByUserId).toBe(userId);
      expect(args[6]).toBe('# Project\n\nInstall: new\n\n## License\nMIT\n'); await args[8]?.(nextSha); return { commitSha: nextSha, commitUrl: 'https://github.com/commit' };
    });
    const results = await Promise.allSettled([docProposalService.approveProposal(prop.id, userId), docProposalService.approveProposal(prop.id, userId)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(commit).toHaveBeenCalledTimes(1);
    expect((await prisma.docProposal.findUniqueOrThrow({ where: { id: prop.id } })).status).toBe('APPLIED');
  });
  it('keeps ambiguous commit intent pending and recovers it on the next approval request', async () => {
    const prop = await proposal();
    vi.spyOn(githubService, 'createDocCommit').mockImplementationOnce(async (...args) => { await args[8]?.(nextSha); throw new Error('timeout after ref update'); });
    await expect(docProposalService.approveProposal(prop.id, userId)).rejects.toMatchObject({ statusCode: 503 });
    expect((await prisma.docProposal.findUniqueOrThrow({ where: { id: prop.id } })).status).toBe('APPLYING');
    expect((await prisma.commitIntent.findFirstOrThrow({ where: { proposalId: prop.id } })).status).toBe('PENDING');
    vi.mocked(githubService.getPullRequestDetails).mockResolvedValue({ ...details, headSha: nextSha });
    vi.spyOn(githubService, 'verifyDocCommit').mockResolvedValue(true); vi.spyOn(githubService, 'isCommitInHistory').mockResolvedValue(true);
    expect((await docProposalService.approveProposal(prop.id, userId)).success).toBe(true);
    expect(githubService.createDocCommit).toHaveBeenCalledTimes(1);
  });
  it('rejects forks, stale revisions and lost write permissions without committing', async () => {
    const prop = await proposal();
    vi.mocked(githubService.getRepositoryById).mockResolvedValue({ id: ghId, owner: 'owner', name: 'project', fullName: 'owner/project', permissions: { pull: true } });
    await expect(docProposalService.approveProposal(prop.id, userId)).rejects.toMatchObject({ statusCode: 403 });
    vi.mocked(githubService.getRepositoryById).mockResolvedValue({ id: ghId, owner: 'owner', name: 'project', fullName: 'owner/project', permissions: { push: true } });
    vi.mocked(githubService.getPullRequestDetails).mockResolvedValue({ ...details, isFork: true });
    await expect(docProposalService.approveProposal(prop.id, userId)).rejects.toMatchObject({ code: 'FORK_WRITE_FORBIDDEN' });
    const second = await proposal(); vi.mocked(githubService.getPullRequestDetails).mockResolvedValue({ ...details, headSha: nextSha });
    await expect(docProposalService.approveProposal(second.id, userId)).rejects.toMatchObject({ code: 'HEAD_ADVANCED' });
  });
  it('rejects cannot overwrite APPLYING after a concurrent approval', async () => {
    const prop = await proposal(); await prisma.docProposal.update({ where: { id: prop.id }, data: { status: 'APPLYING' } });
    await expect(docProposalService.rejectProposal(prop.id, userId)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Hook provisioning and API visibility', () => {
  it('serializes concurrent provisioning and recovers interrupted leases', async () => {
    vi.spyOn(githubService, 'createRepositoryWebhook').mockResolvedValue(456);
    await prisma.repository.update({ where: { id: repoId }, data: { provisioningState: 'PROVISIONING', isActive: false } });
    await Promise.all([repositoryProvisioningService.reconcile(repoId), repositoryProvisioningService.reconcile(repoId)]);
    expect(githubService.createRepositoryWebhook).toHaveBeenCalledTimes(1);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repoId } })).provisioningState).toBe('ACTIVE');
    await prisma.repository.update({ where: { id: repoId }, data: { provisioningState: 'PROVISIONING', provisioningLeaseUntil: new Date(0) } });
    await repositoryProvisioningService.reconcileNext(); expect(githubService.createRepositoryWebhook).toHaveBeenCalledTimes(2);
  });
  it('keeps a hook ID on failed deletion and rejects another owner', async () => {
    vi.spyOn(githubService, 'deleteRepositoryWebhook').mockRejectedValue(new Error('timeout'));
    await repositoryProvisioningService.request(userId, ghId, false, { name: 'project', owner: 'owner', fullName: 'owner/project' });
    const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repoId } });
    expect(repo.isActive).toBe(false); expect(repo.webhookId).toBe(123); expect(repo.provisioningState).toBe('ERROR');
    await expect(repositoryProvisioningService.request(otherId, ghId, true, { name: 'forged', owner: 'bad', fullName: 'bad/forged' })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('shows worker results and true aggregate totals, rejects invalid pagination', async () => {
    await newRun({ status: 'SUCCESS' }); await newRun({ headSha: nextSha, status: 'SKIPPED' });
    const res = await request(app).get('/api/webhooks/logs?limit=1').set('Authorization', `Bearer ${assertion(userId)}`);
    expect(res.status).toBe(200); expect(res.body.data.items).toHaveLength(1); expect(res.body.data.aggregates.successfulReviews).toBe(1); expect(res.body.data.pagination.total).toBe(2);
    expect((await request(app).get('/api/webhooks/logs?page=NaN').set('Authorization', `Bearer ${assertion(userId)}`)).status).toBe(400);
  });
});


describe('OAuth bootstrap and token storage', () => {
  it('validates the server-side OAuth token, stores ciphertext only and returns canonical identity', async () => {
    vi.spyOn(githubService, 'getAuthenticatedUser').mockResolvedValue({ id: ghId, login: 'owner', email: null, avatar_url: 'https://example.com/avatar.png' } as any);
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer gho_server_bootstrap');
    expect(res.status).toBe(200); expect(res.body.data.id).toBe(userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.accessToken).toBe(''); expect(user.encryptedToken).not.toContain('gho_server_bootstrap');
    expect(JSON.stringify(res.body)).not.toContain('gho_server_bootstrap');
    expect(cryptoService.decryptToken({ ciphertext: user.encryptedToken!, iv: user.tokenIv!, tag: user.tokenTag!, keyVersion: user.tokenKeyVersion })).toBe('gho_server_bootstrap');
  });
  it('never accepts raw credentials on normal BFF endpoints', async () => {
    expect((await request(app).get('/api/repositories').set('Authorization', 'Bearer gho_untrusted')).status).toBe(401);
  });
  it('requires both identity claims to match the same provisioned account', async () => {
    const token = cryptoService.signInternalAssertion({ userId, githubId: ghId + 1, username: 'other' });
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});


describe('Legacy credential backfill', () => {
  it('replaces plaintext with authenticated ciphertext without printing or losing the token', async () => {
    await prisma.user.update({ where: { id: userId }, data: { accessToken: 'gho_legacy_secret', encryptedToken: null, tokenIv: null, tokenTag: null, tokenKeyVersion: null } });
    expect(await migrateCredentials()).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.accessToken).toBe('');
    expect(cryptoService.decryptToken({ ciphertext: user.encryptedToken!, iv: user.tokenIv!, tag: user.tokenTag!, keyVersion: user.tokenKeyVersion })).toBe('gho_legacy_secret');
  });
});
