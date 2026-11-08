import { startPolling } from "./services/pollingWorker";
import { UpdateProcessor } from "./services/updateProcessor";
import "dotenv/config";
import Redis from "ioredis";
import { RedisStore } from "./storage/redisStore";
import { Connections } from "./storage/connections";
import { createConfiguredProviders } from "./providers/registry";
import { ShopBackendClient } from "./clients/shopBackendClient";
import { ConversationService } from "./services/conversationService";
import { ConnectionService } from "./services/connectionService";
import { MessageService } from "./services/messageService";
import { createApp } from "./http/app";
import { UserSessions } from "./storage/userSessions";
import type { Server } from "http";
import { resolveUpdateModes } from "./updateModes";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const apiKey = required("BOT_SERVICE_API_KEY");
if (apiKey.length < 32)
  throw new Error("BOT_SERVICE_API_KEY must contain at least 32 characters");
const redis = new Redis(required("REDIS_URL"), {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on("error", () => console.warn("Bot storage unavailable"));
const store = new RedisStore(redis);
const connections = new Connections(
  store,
  required("BOT_STORAGE_ENCRYPTION_KEY"),
);
const providerRuntime = createConfiguredProviders(process.env);
const { providers } = providerRuntime;
const backend = new ShopBackendClient(
  required("SHOP_BACKEND_URL_TEMPLATE"),
  apiKey,
  new UserSessions(store, required("BOT_STORAGE_ENCRYPTION_KEY"), Number(process.env.BOT_SESSION_TTL_SECONDS) || 30 * 86400),
);
const modes = resolveUpdateModes(process.env);
const conversation = new ConversationService(store, backend);
const app = createApp({
  apiKey,
  store,
  connections,
  providers,
  connectionService: new ConnectionService(
    connections,
    store,
    providers,
    backend,
    process.env.PUBLIC_BASE_URL || "",
    modes,
  ),
  conversation,
  messages: new MessageService(store, connections, providers),
});
let stopPolling = () => {};
let server: Server | undefined;
let stopping = false;
const stop = async (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  stopPolling();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await providerRuntime.close();
  redis.disconnect();
  process.exit(exitCode);
};
async function start() {
  // enableOfflineQueue=false requires an established connection before scanning for bots.
  await redis.connect();
  stopPolling = Object.values(modes).includes("polling") ? startPolling(store, connections, providers, new UpdateProcessor(store, providers, conversation), modes) : () => {};
  server = app.listen(Number(process.env.PORT) || 3010, () => console.log("Bot integration service started", { storage: "ready", modes }));
  server.on("error", () => { console.error("Bot service could not listen on its configured port"); void stop(1); });
}
void start().catch(() => { console.error("Bot service startup failed: check Redis connectivity and service configuration"); void stop(1); });
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
