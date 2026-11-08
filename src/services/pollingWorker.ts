import { randomUUID } from "crypto";
import { BotProvider, IntegrationError, Provider, Store } from "../contracts";
import { Connections } from "../storage/connections";
import { UpdateProcessor } from "./updateProcessor";
import { UpdateModes } from "../updateModes";

/** Poll only persisted polling connections whose provider still enables polling. */
export function startPolling(store: Store, connections: Connections, providers: Record<Provider, BotProvider>, processor: UpdateProcessor, modes?: UpdateModes): () => void {
  let stopped = false; let running = false; let directoryRetryAt = 0;
  const retries = new Map<string, number>();
  const tick = async () => {
    if (running || stopped || Date.now() < directoryRetryAt) return;
    running = true;
    try {
      for (const connection of await connections.pollingConnections()) {
        if (stopped) break;
        if (modes && modes[connection.provider] !== "polling") continue;
        if ((retries.get(connection.id) || 0) > Date.now()) continue;
        const lockKey = `polling:${connection.id}`; const lock = randomUUID();
        if (!await store.set(lockKey, lock, { ttl: 60, onlyIfAbsent: true })) continue;
        try {
          const key = `polling-offset:${connection.id}`;
          const offset = Number(await store.get(key)) || 0;
          const updates = await providers[connection.provider].getUpdates(connection.token, offset);
          if (!Array.isArray(updates)) throw new IntegrationError("Invalid update response");
          for (const update of updates) {
            const id = (update as { update_id?: number })?.update_id;
            if (!Number.isSafeInteger(id) || id! < offset) continue;
            await processor.process(connection, update);
            await store.set(key, String(id! + 1));
          }
          retries.delete(connection.id);
        } catch (error) {
          const delay = Math.max(30000, error instanceof IntegrationError ? error.retryAfter * 1000 : 0);
          retries.set(connection.id, Date.now() + delay);
          console.warn("Bot polling failed", { provider: connection.provider, code: error instanceof IntegrationError ? error.code : "INTEGRATION_REQUEST_FAILED", retryInSeconds: delay / 1000 });
        } finally { await store.release(lockKey, lock); }
      }
    } catch (error) {
      directoryRetryAt = Date.now() + 30000;
      const rawCode = (error as { code?: unknown })?.code;
      const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : "BOT_STORAGE_UNAVAILABLE";
      console.warn("Bot polling storage unavailable", { code, retryInSeconds: 30 });
    }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 5000); timer.unref(); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
