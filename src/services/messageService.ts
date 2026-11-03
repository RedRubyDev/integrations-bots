import { createHash, randomUUID } from "crypto";
import { BotProvider, IntegrationError, Provider, Store } from "../contracts";
import { Connections } from "../storage/connections";

export type SendMessage = {
  tenantId: string;
  provider: Provider;
  chatId: string;
  text: string;
  idempotencyKey: string;
};
export class MessageService {
  constructor(
    private readonly store: Store,
    private readonly connections: Connections,
    private readonly providers: Record<Provider, BotProvider>,
  ) {}
  async send(input: SendMessage): Promise<{ duplicate: boolean }> {
    const connection = await this.connections.get(
      this.connections.id(input.tenantId, input.provider),
    );
    if (
      !connection ||
      connection.tenantId !== input.tenantId ||
      connection.provider !== input.provider
    )
      throw new IntegrationError("Bot is not connected", 409);
    const digest = createHash("sha256")
      .update(JSON.stringify([input.chatId, input.text]))
      .digest("hex");
    const key = `message:${connection.id}:${createHash("sha256").update(input.idempotencyKey).digest("hex")}`;
    const lock = randomUUID();
    if (
      !(await this.store.set(`${key}:lock`, lock, {
        ttl: 60,
        onlyIfAbsent: true,
      }))
    )
      throw new IntegrationError("Message is being processed", 409, 2);
    try {
      const sent = await this.store.get(key);
      if (sent && sent !== digest)
        throw new IntegrationError(
          "Idempotency key has a different payload",
          422,
        );
      if (sent) return { duplicate: true };
      await this.providers[input.provider].send(
        connection.token,
        input.chatId,
        input.text,
      );
      await this.store.set(key, digest, { ttl: 7 * 86400 });
      return { duplicate: false };
    } finally {
      await this.store.release(`${key}:lock`, lock);
    }
  }
}
