import { pathToFileURL } from 'node:url';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { cryptoService, resolveUserAccessToken } from '../services/crypto.service.js';

export async function migrateCredentials() {
  let cursor: string | undefined;
  let migrated = 0;
  while (true) {
    const users = await prisma.user.findMany({ take: 100, orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!users.length) break;
    for (const user of users) {
      if (user.tokenRevokedAt) {
        await prisma.user.updateMany({ where: { id: user.id, updatedAt: user.updatedAt, tokenRevokedAt: { not: null } }, data: { accessToken: '', encryptedToken: null, tokenIv: null, tokenTag: null, tokenKeyVersion: null } });
        continue;
      }
      if (!user.accessToken && !user.encryptedToken) continue; // Reconnect users created without credentials by older code.
      if (!user.accessToken && user.tokenKeyVersion === env.ENCRYPTION_KEY_VERSION) continue;
      const token = resolveUserAccessToken(user);
      const encrypted = cryptoService.encryptToken(token);
      const result = await prisma.user.updateMany({ where: { id: user.id, updatedAt: user.updatedAt, tokenRevokedAt: null }, data: {
        accessToken: '', encryptedToken: encrypted.ciphertext, tokenIv: encrypted.iv, tokenTag: encrypted.tag, tokenKeyVersion: encrypted.keyVersion,
      } });
      migrated += result.count;
    }
    cursor = users.at(-1)!.id;
  }
  return migrated;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) migrateCredentials().then(count => console.log(`Credential records migrated: ${count}`)).catch(() => { console.error('Credential migration stopped; inspect key configuration. No credentials were printed.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
