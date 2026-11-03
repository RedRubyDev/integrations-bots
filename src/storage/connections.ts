import { createHash } from "crypto";
import { Connection, IntegrationError, Provider, Store } from "../contracts";
import { CryptoBox } from "./cryptoBox";

export class Connections {
  private readonly crypto: CryptoBox;
  constructor(private readonly store: Store, key: string) {
    this.crypto = new CryptoBox(key);
  }
  id(tenantId: string, provider: Provider) { return createHash("sha256").update(JSON.stringify([tenantId, provider])).digest("hex").slice(0, 40); }
  async get(id: string): Promise<Connection | null> {
    const raw = await this.store.get(`connection:${id}`);
    if (!raw) return null;
    return this.crypto.open<Connection>(raw);
  }
  async save(connection: Connection): Promise<void> {
    await this.store.set(`connection:${connection.id}`, this.crypto.seal(connection));
  }
  async pollingConnections(): Promise<Connection[]> {
    const keys = await this.store.scan("connection:");
    const results: Connection[] = [];
    for (const key of keys) {
      const connection = await this.get(key.slice("connection:".length));
      if (connection?.updateMode === "polling") results.push(connection);
    }
    return results;
  }
  async claim(provider: Provider, token: string, tenantId: string): Promise<void> {
    const key = `owner:${provider}:${createHash("sha256").update(token).digest("hex")}`;
    if (!await this.store.set(key, tenantId, { onlyIfAbsent: true }) && await this.store.get(key) !== tenantId) {
      throw new IntegrationError("Bot already belongs to another shop", 409);
    }
  }
}
