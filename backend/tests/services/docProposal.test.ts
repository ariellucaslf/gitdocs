import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../src/config/prisma.js';
import { docProposalService } from '../../src/services/docProposal.service.js';
import { githubService } from '../../src/services/github.service.js';
import { repoA, userA, userB } from '../fixtures/index.js';
vi.mock('../../src/config/prisma.js', () => ({ prisma: { docProposal: { findUnique: vi.fn(), updateMany: vi.fn() } } }));
vi.mock('../../src/services/github.service.js', () => ({ githubService: { getRepositoryById: vi.fn(), createDocCommit: vi.fn() } }));
beforeEach(() => { vi.resetAllMocks(); });
describe('Proposal ownership before effects', () => {
  it('rejects another owner without locking the proposal or resolving GitHub permissions', async () => {
    vi.mocked(prisma.docProposal.findUnique).mockResolvedValue({ id: 'proposal', repository: { ...repoA, user: userA } } as any);
    await expect(docProposalService.approveProposal('proposal', userB.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(docProposalService.rejectProposal('proposal', userB.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.docProposal.updateMany).not.toHaveBeenCalled(); expect(githubService.getRepositoryById).not.toHaveBeenCalled();
  });
  it('does not expose credentials through proposal reads', async () => {
    vi.mocked(prisma.docProposal.findUnique).mockResolvedValue({ id: 'proposal', previewContent: 'safe', repository: { ...repoA, user: userA } } as any);
    const result = await docProposalService.getProposal('proposal', userA.id);
    expect(result).not.toHaveProperty('repository'); expect(JSON.stringify(result)).not.toContain(userA.accessToken);
  });
  it('rejects missing resources consistently', async () => {
    vi.mocked(prisma.docProposal.findUnique).mockResolvedValue(null);
    await expect(docProposalService.getProposal('missing', userA.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
