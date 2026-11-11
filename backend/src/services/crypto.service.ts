import crypto from 'node:crypto';
import { env } from '../config/env.js';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
}

export interface InternalAssertionPayload {
  sub: string;
  iss: 'gitdocs-bff';
  aud: 'gitdocs-api';
  exp: number;
  iat: number;
  ghId: number;
  username: string;
}

export class CryptoService {
  private currentKey: Buffer;
  private previousKey: Buffer | null;
  private currentKeyVersion: string;

  constructor() {
    this.currentKey = this.normalizeKey(env.ENCRYPTION_KEY);
    this.previousKey = env.ENCRYPTION_KEY_PREVIOUS
      ? this.normalizeKey(env.ENCRYPTION_KEY_PREVIOUS)
      : null;
    this.currentKeyVersion = env.ENCRYPTION_KEY_VERSION || 'v1';
  }

  private normalizeKey(keyStr: string): Buffer {
    if (keyStr.length === 64) {
      return Buffer.from(keyStr, 'hex');
    }
    const hash = crypto.createHash('sha256').update(keyStr).digest();
    return hash;
  }

  /**
   * Encrypts plaintext token using authenticated AES-256-GCM with a unique 96-bit nonce.
   */
  encryptToken(plaintext: string): EncryptedPayload {
    if (!plaintext) {
      throw new Error('Plaintext token cannot be empty');
    }

    const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.currentKey, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag(); // 128-bit authentication tag

    return {
      ciphertext: ciphertext.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      keyVersion: this.currentKeyVersion,
    };
  }

  /**
   * Decrypts ciphertext using AES-256-GCM, verifying authentication tag and key version.
   * Supports reading data encrypted with the previous key version during rotation (ADR 0002, V22).
   */
  decryptToken(encrypted: {
    ciphertext: string;
    iv: string;
    tag: string;
    keyVersion?: string | null;
  }): string {
    const { ciphertext, iv, tag, keyVersion } = encrypted;

    let keyToUse = this.currentKey;

    if (keyVersion && keyVersion !== this.currentKeyVersion) {
      if (this.previousKey) {
        keyToUse = this.previousKey;
      } else {
        throw new Error(`Unsupported encryption key version '${keyVersion}' and no previous key configured`);
      }
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyToUse, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'hex')),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch {
      throw new Error('Failed to decrypt token: authentication tag verification failed or key mismatch');
    }
  }

  /**
   * Generates a compact HS256-signed internal assertion token for BFF server-to-server calls.
   */
  signInternalAssertion(payload: {
    userId: string;
    githubId: number;
    username: string;
    ttlSeconds?: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const ttl = payload.ttlSeconds ?? 120; // 2 minutes default

    const header = { alg: 'HS256', typ: 'JWT' };
    const assertionPayload: InternalAssertionPayload = {
      sub: payload.userId,
      iss: 'gitdocs-bff',
      aud: 'gitdocs-api',
      iat: now,
      exp: now + ttl,
      ghId: payload.githubId,
      username: payload.username,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(assertionPayload)).toString('base64url');

    const signature = crypto
      .createHmac('sha256', env.INTERNAL_AUTH_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * Validates a signed internal assertion token and checks exp, iss, aud, and signature (V21).
   */
  verifyInternalAssertion(token: string): InternalAssertionPayload {
    if (!token || typeof token !== 'string') {
      throw new Error('Missing assertion token');
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1]) {
      throw new Error('Malformed assertion token structure');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify header algorithm
    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid assertion token header');
    }

    if (header.alg !== 'HS256') {
      throw new Error(`Unsupported algorithm '${header.alg}', only HS256 is permitted`);
    }

    if (!signatureB64) {
      throw new Error('Missing assertion signature');
    }

    // Verify signature with constant-time comparison
    const expectedSig = crypto
      .createHmac('sha256', env.INTERNAL_AUTH_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signatureB64);
    const expectedSigBuf = Buffer.from(expectedSig);

    if (
      sigBuf.length !== expectedSigBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedSigBuf)
    ) {
      throw new Error('Invalid assertion signature');
    }

    // Verify payload claims
    let payload: InternalAssertionPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid assertion token payload');
    }

    if (payload.iss !== 'gitdocs-bff') {
      throw new Error(`Invalid issuer '${payload.iss}'`);
    }

    if (payload.aud !== 'gitdocs-api') {
      throw new Error(`Invalid audience '${payload.aud}'`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      throw new Error('Assertion token expired');
    }

    if (!payload.sub || !payload.ghId) {
      throw new Error('Assertion missing required subject or githubId claims');
    }

    return payload;
  }
}

export const cryptoService = new CryptoService();

/**
 * Safely resolves a user's GitHub access token, preferring encrypted storage
 * and checking for credential revocation (ADR 0002, V22).
 */
export function resolveUserAccessToken(user: {
  accessToken?: string | null;
  encryptedToken?: string | null;
  tokenIv?: string | null;
  tokenTag?: string | null;
  tokenKeyVersion?: string | null;
  tokenRevokedAt?: Date | null;
}): string {
  if (user.tokenRevokedAt) {
    throw new Error('TOKEN_REVOKED: User credentials have been revoked. Please reconnect.');
  }

  if (user.encryptedToken && user.tokenIv && user.tokenTag) {
    return cryptoService.decryptToken({
      ciphertext: user.encryptedToken,
      iv: user.tokenIv,
      tag: user.tokenTag,
      keyVersion: user.tokenKeyVersion,
    });
  }

  if (user.accessToken) {
    return user.accessToken;
  }

  throw new Error('No credentials available for user.');
}
