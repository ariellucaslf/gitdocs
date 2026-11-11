import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { app } from '../../src/app.js';
import {
  cryptoService,
  resolveUserAccessToken,
} from '../../src/services/crypto.service.js';
import { prisma } from '../../src/config/prisma.js';
import { userA } from '../fixtures/index.js';

vi.mock('../../src/config/prisma.js', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    repository: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../../src/services/github.service.js', () => ({
  githubService: {
    listUserRepositories: vi.fn().mockResolvedValue([]),
  },
}));

describe('Server-Side Credential Protection & BFF Assertions (ADR 0002, V21, V22)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case V21: Internal Assertion Signing & Tamper Verification', () => {
    it('accepts valid short-lived internal assertion from BFF and grants access', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
        ...userA,
        tokenRevokedAt: null,
      } as any);

      const assertion = cryptoService.signInternalAssertion({
        userId: userA.id,
        githubId: userA.githubId,
        username: userA.username,
        ttlSeconds: 60,
      });

      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${assertion}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects forged assertion with modified payload or invalid signature with 401', async () => {
      const validAssertion = cryptoService.signInternalAssertion({
        userId: userA.id,
        githubId: userA.githubId,
        username: userA.username,
      });

      const parts = validAssertion.split('.');
      // Tamper with payload (elevate user ID or ghId)
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: 'attacker-uuid',
          iss: 'gitdocs-bff',
          aud: 'gitdocs-api',
          exp: Math.floor(Date.now() / 1000) + 120,
          ghId: 999999,
          username: 'attacker',
        })
      ).toString('base64url');

      const tamperedAssertion = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${tamperedAssertion}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid assertion');
    });

    it('rejects expired internal assertion with 401', async () => {
      const expiredAssertion = cryptoService.signInternalAssertion({
        userId: userA.id,
        githubId: userA.githubId,
        username: userA.username,
        ttlSeconds: -10, // Expired 10 seconds ago
      });

      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${expiredAssertion}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Assertion token expired');
    });

    it('rejects assertion with unauthorized algorithm (e.g. alg: none)', async () => {
      const insecureHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: userA.id,
          iss: 'gitdocs-bff',
          aud: 'gitdocs-api',
          exp: Math.floor(Date.now() / 1000) + 120,
          ghId: userA.githubId,
          username: userA.username,
        })
      ).toString('base64url');

      const noneToken = `${insecureHeader}.${payload}.`;

      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${noneToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('only HS256 is permitted');
    });

    it('rejects assertion with mismatched issuer or audience', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: userA.id,
          iss: 'rogue-service',
          aud: 'gitdocs-api',
          exp: Math.floor(Date.now() / 1000) + 120,
          ghId: userA.githubId,
          username: userA.username,
        })
      ).toString('base64url');

      const sig = crypto
        .createHmac('sha256', process.env.INTERNAL_AUTH_SECRET || 'gitdocs-internal-auth-secret-change-in-production')
        .update(`${header}.${payload}`)
        .digest('base64url');

      const rogueToken = `${header}.${payload}.${sig}`;

      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${rogueToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid issuer');
    });
  });

  describe('Case V22: AES-256-GCM Storage Encryption, Key Rotation & Revocation', () => {
    it('encrypts token using AES-256-GCM producing unique IVs and valid auth tags', () => {
      const plainToken = 'ghp_secretTokenExample1234567890abcdef';

      const enc1 = cryptoService.encryptToken(plainToken);
      const enc2 = cryptoService.encryptToken(plainToken);

      // Probabilistic encryption check: same plaintext yields different ciphertexts & IVs
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

      // Decryption restores exact plaintext
      expect(cryptoService.decryptToken(enc1)).toBe(plainToken);
      expect(cryptoService.decryptToken(enc2)).toBe(plainToken);
    });

    it('fails decryption and detects tampering when ciphertext or tag is modified', () => {
      const plainToken = 'ghp_secretTokenExample1234567890abcdef';
      const enc = cryptoService.encryptToken(plainToken);

      // Tamper ciphertext
      const tamperedCiphertext = enc.ciphertext.slice(0, -2) + '00';

      expect(() =>
        cryptoService.decryptToken({
          ...enc,
          ciphertext: tamperedCiphertext,
        })
      ).toThrow('Failed to decrypt token: authentication tag verification failed');
    });

    it('rejects access and resolution when user credentials have been revoked', async () => {
      const revokedUser = {
        ...userA,
        tokenRevokedAt: new Date(),
      };

      // 1. Service resolution check
      expect(() => resolveUserAccessToken(revokedUser as any)).toThrow(
        'TOKEN_REVOKED: User credentials have been revoked. Please reconnect.'
      );

      // 2. HTTP middleware check
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(revokedUser as any);

      const assertion = cryptoService.signInternalAssertion({
        userId: userA.id,
        githubId: userA.githubId,
        username: userA.username,
      });

      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${assertion}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('User credentials have been revoked');
    });
  });
});
