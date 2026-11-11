import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import crypto from 'node:crypto';
import { authOptions } from '../../../../lib/auth';

const INTERNAL_SECRET =
  process.env.INTERNAL_AUTH_SECRET || '';
const BACKEND_INTERNAL_URL =
  process.env.BACKEND_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:4000/api';

async function generateAssertion(req: NextRequest) {
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (!token || token.identityVersion !== 2 || typeof token.sub !== 'string' || !Number.isInteger(token.githubId) || !token.username) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = 120; // 2 minutes short-lived assertion

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: token.sub,
    iss: 'gitdocs-bff',
    aud: 'gitdocs-api',
    iat: now,
    exp: now + ttl,
    ghId: token.githubId,
    username: (token.username as string) || 'user',
  };

  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', INTERNAL_SECRET)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64url');

  return `${encHeader}.${encPayload}.${signature}`;
}

async function handleProxy(
  req: NextRequest,
  { params: promisedParams }: { params: Promise<{ path: string[] }> }
) {
  const params = await promisedParams;
  if (INTERNAL_SECRET.length < 32) {
    return NextResponse.json({ success: false, error: 'Server authentication is not configured' }, { status: 503 });
  }
  const path = params.path.join('/');
  const allowed = (req.method === 'GET' && /^(repositories|auth\/me|webhooks\/logs|proposals\/[^/]+|repositories\/[^/]+\/proposals)$/.test(path))
    || (req.method === 'POST' && /^(repositories\/toggle|proposals\/[^/]+\/(approve|reject))$/.test(path));
  if (!allowed || params.path.some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    return NextResponse.json({ success: false, error: 'Route not found' }, { status: 404 });
  }
  if (req.method !== 'GET') {
    const expectedOrigin = new URL(process.env.NEXTAUTH_URL || req.url).origin;
    if (req.headers.get('origin') !== expectedOrigin || !req.headers.get('content-type')?.startsWith('application/json')) {
      return NextResponse.json({ success: false, error: 'Invalid request origin or content type' }, { status: 403 });
    }
  }
  const session = await getServerSession(authOptions);
  if (!session || !session.user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Session required' },
      { status: 401 }
    );
  }

  const assertionToken = await generateAssertion(req);
  if (!assertionToken) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Failed to generate identity assertion' },
      { status: 401 }
    );
  }

  const pathSegments = params.path || [];
  const targetPath = pathSegments.join('/');
  const query = req.nextUrl.search;
  const targetUrl = `${BACKEND_INTERNAL_URL}/${targetPath}${query}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${assertionToken}`,
    'Content-Type': 'application/json',
  };

  let body: string | undefined;
  if (req.method !== 'GET') {
    body = await req.text();
  }

  try {
    const backendRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });

    const data = await backendRes.json();
    return NextResponse.json(data, { status: backendRes.status });
  } catch (err: unknown) {
    console.error(`[BFF Proxy Error] ${req.method} ${targetUrl}:`, err);
    return NextResponse.json(
      { success: false, error: 'Backend service unreachable or offline' },
      { status: 502 }
    );
  }
}

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const DELETE = handleProxy;
export const PATCH = handleProxy;
