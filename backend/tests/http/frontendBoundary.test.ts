import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { authOptions } from '../../../frontend/src/lib/auth';
import { GET, POST } from '../../../frontend/src/app/api/bff/[...path]/route';
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('next-auth/providers/github', () => ({ default: vi.fn(() => ({})) }));
const identity = { sub: 'local-user-id', githubId: 123, username: 'alice', identityVersion: 2 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerSession).mockResolvedValue({ user: { id: identity.sub } });
  vi.mocked(getToken).mockResolvedValue(identity);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ success: true, data: { items: [] } })));
});
afterEach(() => { vi.unstubAllGlobals(); });
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
describe('OAuth and BFF boundaries', () => {
  it('exchanges the OAuth token for canonical identity and removes it from the stored JWT', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, data: { id: 'canonical-id', githubId: 123, username: 'alice' } }));
    const result = await authOptions.callbacks!.jwt!({ token: {}, account: { access_token: 'gho_server_only' } } as any);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), expect.objectContaining({ headers: { Authorization: 'Bearer gho_server_only' } }));
    expect(result).toMatchObject({ sub: 'canonical-id', identityVersion: 2 }); expect(result).not.toHaveProperty('accessToken');
  });
  it('does not retain identity from legacy sessions', async () => {
    const result = await authOptions.callbacks!.jwt!({ token: { sub: 'old', accessToken: 'legacy-secret' } } as any);
    expect(result).toEqual({});
  });
  it('never exposes token in the browser session', async () => {
    const result = await authOptions.callbacks!.session!({ session: { user: {} }, token: { ...identity, accessToken: 'secret' } } as any);
    expect(result).not.toHaveProperty('accessToken'); expect(result.user.id).toBe(identity.sub);
  });
  it('forwards identity assertions instead of browser supplied credentials', async () => {
    const result = await GET(new NextRequest('http://localhost:3000/api/bff/repositories', { headers: { Authorization: 'Bearer attacker-token' } }), context(['repositories']));
    expect(result.status).toBe(200);
    const headers = vi.mocked(fetch).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).not.toContain('attacker-token'); expect(headers.Authorization!.split('.')).toHaveLength(3);
  });
  it.each(['https://attacker.test', 'null'])('rejects a cross-origin mutation from %s', async origin => {
    const result = await POST(new NextRequest('http://localhost:3000/api/bff/repositories/toggle', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}' }), context(['repositories', 'toggle']));
    expect(result.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it('permits a same-origin mutation and rejects proxy traversal or unknown routes', async () => {
    expect((await POST(new NextRequest('http://localhost:3000/api/bff/repositories/toggle', { method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: '{}' }), context(['repositories', 'toggle']))).status).toBe(200);
    vi.mocked(fetch).mockClear();
    expect((await GET(new NextRequest('http://localhost:3000/api/bff/health'), context(['..', 'health']))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects old sessions and signed-in sessions with no canonical identity', async () => {
    vi.mocked(getToken).mockResolvedValue({ sub: 'legacy', githubId: 123 });
    expect((await GET(new NextRequest('http://localhost:3000/api/bff/repositories'), context(['repositories']))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
