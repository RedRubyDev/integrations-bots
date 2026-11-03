import { Connection, Store } from "../contracts";
import { CryptoBox } from "./cryptoBox";

export type UserSession = { accessToken: string; refreshToken: string };
export class UserSessions {
  private readonly crypto: CryptoBox;
  constructor(private readonly store: Store, encryptionKey: string, private readonly ttl = 30 * 86400) {
    this.crypto = new CryptoBox(encryptionKey);
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("BOT_SESSION_TTL_SECONDS must be a positive integer");
  }
  private key(connection: Connection, externalUserId: string) { return `user-session:${connection.id}:${externalUserId}`; }
  async get(connection: Connection, externalUserId: string): Promise<UserSession | null> {
    const raw = await this.store.get(this.key(connection, externalUserId));
    return raw ? this.crypto.open<UserSession>(raw) : null;
  }
  async save(connection: Connection, externalUserId: string, session: UserSession): Promise<void> {
    await this.store.set(this.key(connection, externalUserId), this.crypto.seal(session), { ttl: this.ttl });
  }
  async remove(connection: Connection, externalUserId: string): Promise<void> { await this.store.delete(this.key(connection, externalUserId)); }
}
