import { randomBytes, randomUUID } from "crypto";
import {
  BotProvider,
  Connection,
  IntegrationError,
  Provider,
  ShopBackend,
  Store,
} from "../contracts";
import { normalizeDomain } from "../domain";
import { Connections } from "../storage/connections";

export class ConnectionService {
  constructor(
    private readonly connections: Connections,
    private readonly store: Store,
    private readonly providers: Record<Provider, BotProvider>,
    private readonly backend: ShopBackend,
    private readonly publicBaseUrl: string,
    private readonly updateMode: "webhook" | "polling" = "webhook",
  ) {
    if (updateMode === "polling" && process.env.NODE_ENV === "production") throw new Error("Polling mode is intended for local development; use HTTPS webhooks in production");
    if (updateMode === "webhook" && !publicBaseUrl.startsWith("https://"))
      throw new Error("PUBLIC_BASE_URL must use HTTPS");
  }
  async configure(input: {
    tenantId: string;
    domain: string;
    provider: Provider;
    token: string;
  }) {
    const domain = normalizeDomain(input.domain, this.updateMode === "polling");
    if (!domain || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(input.token))
      throw new IntegrationError("Invalid shop domain or bot token format", 422, 0, "INVALID_CONNECTION");
    if (this.updateMode === "webhook") {
      const host = new URL(this.publicBaseUrl).hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "example.com" || host.endsWith(".example.com")) {
        throw new IntegrationError("Configure a public HTTPS callback URL or use development polling", 422, 0, "PUBLIC_WEBHOOK_REQUIRED");
      }
    }
    const id = this.connections.id(input.tenantId, input.provider);
    const lockKey = `setup:${id}`;
    const lock = randomUUID();
    if (!(await this.store.set(lockKey, lock, { ttl: 60, onlyIfAbsent: true })))
      throw new IntegrationError("Setup is already running", 409);
    try {
      const previous = await this.connections.get(id);
      const connection: Connection = {
        ...input,
        domain,
        id,
        username: "",
        updateMode: this.updateMode,
        webhookSecret:
          previous?.token === input.token
            ? previous.webhookSecret
            : randomBytes(32).toString("hex"),
      };
      await this.backend.verify(connection);
      await this.connections.claim(input.provider, input.token, input.tenantId);
      const provider = this.providers[input.provider];
      const webhookUrl = `${this.publicBaseUrl.replace(/\/$/, "")}/webhooks/${id}/${connection.webhookSecret}`;
      connection.username = this.updateMode === "polling" ? await provider.preparePolling(input.token) :
        await provider.setup(input.token, webhookUrl, connection.webhookSecret);
      await this.connections.save(connection);
      return {
        connectionId: id,
        username: connection.username,
        url: provider.profileUrl(connection.username),
      };
    } finally {
      await this.store.release(lockKey, lock);
    }
  }
}
