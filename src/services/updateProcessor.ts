import { randomUUID } from "crypto";
import { BotProvider, Connection, IntegrationError, Provider, Store } from "../contracts";
import { ConversationService } from "./conversationService";

/** Webhooks and local polling share the same deduplication and per-chat serialization. */
export class UpdateProcessor {
  constructor(private readonly store: Store, private readonly providers: Record<Provider, BotProvider>, private readonly conversation: ConversationService) {}
  async process(connection: Connection, update: unknown): Promise<void> {
    const provider = this.providers[connection.provider];
    const message = provider.parseUpdate(update);
    if (!message) return;
    const lockKey = `chat:${connection.id}:${message.userId}`; const lock = randomUUID();
    if (!await this.store.set(lockKey, lock, { ttl: 60, onlyIfAbsent: true })) throw new IntegrationError("Chat update is being processed", 503);
    try {
      const updateKey = `update:${connection.id}:${message.updateId}`;
      if (await this.store.get(updateKey)) return;
      await this.conversation.handle(connection, provider, message);
      await this.store.set(updateKey, "1", { ttl: 14 * 86400 });
    } finally { await this.store.release(lockKey, lock); }
  }
}
