import { Session } from "@shopify/shopify-app-react-router/server";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { decrypt, encrypt, isEncrypted } from "./crypto.server";

// Wraps another session storage (PrismaSessionStorage) so access and refresh
// tokens are encrypted before they're written and decrypted when read. Rows
// still holding a plain-text token (written before this wrapper existed) are
// read as-is and re-encrypted the next time the library stores the session;
// scripts/encrypt-sessions.ts converts them all in one go.
export class EncryptedSessionStorage implements SessionStorage {
  constructor(private readonly inner: SessionStorage) {}

  storeSession(session: Session): Promise<boolean> {
    return this.inner.storeSession(mapTokens(session, encrypt));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    return session ? mapTokens(session, decryptIfNeeded) : undefined;
  }

  deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    return sessions.map((session) => mapTokens(session, decryptIfNeeded));
  }
}

function decryptIfNeeded(value: string): string {
  return isEncrypted(value) ? decrypt(value) : value;
}

// Returns a copy, never mutating the session the library is still using.
function mapTokens(session: Session, transform: (value: string) => string) {
  const copy = new Session(session.toObject());
  if (copy.accessToken) copy.accessToken = transform(copy.accessToken);
  if (copy.refreshToken) copy.refreshToken = transform(copy.refreshToken);
  return copy;
}
