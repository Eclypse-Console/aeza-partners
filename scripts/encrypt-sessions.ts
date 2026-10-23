// One-off: encrypts access/refresh tokens in Session rows written before
// token encryption existed. Safe to run more than once; already-encrypted
// values are skipped. Prints counts only, never token values.
//
//   npm run sessions:encrypt
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { PrismaClient } from "@prisma/client";
import { encrypt, isEncrypted } from "../app/lib/crypto.server.ts";

const prisma = new PrismaClient();

try {
  const sessions = await prisma.session.findMany({
    select: { id: true, accessToken: true, refreshToken: true },
  });

  let updated = 0;
  for (const session of sessions) {
    const data: { accessToken?: string; refreshToken?: string } = {};
    if (session.accessToken && !isEncrypted(session.accessToken)) {
      data.accessToken = encrypt(session.accessToken);
    }
    if (session.refreshToken && !isEncrypted(session.refreshToken)) {
      data.refreshToken = encrypt(session.refreshToken);
    }
    if (Object.keys(data).length > 0) {
      await prisma.session.update({ where: { id: session.id }, data });
      updated++;
    }
  }

  console.log(`Checked ${sessions.length} sessions, encrypted ${updated}.`);
} finally {
  await prisma.$disconnect();
}
