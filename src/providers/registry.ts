import {
  BotProvider,
  IncomingMessage,
  IntegrationError,
  Provider,
} from "../contracts";
import { createProviderTransport, createTelegramRelayTransport } from "./transport";

type Fetch = typeof fetch;

function parseUpdate(value: unknown): IncomingMessage | null {
  const update = value as any;
  const message = update?.message;
  if (
    !Number.isSafeInteger(update?.update_id) ||
    !Number.isSafeInteger(message?.message_id) ||
    message?.chat?.type !== "private" ||
    message?.from?.is_bot ||
    !Number.isSafeInteger(message?.from?.id) ||
    message.from.id !== message.chat.id ||
    typeof message.text !== "string" ||
    message.text.length > 4096
  )
    return null;
  return {
    updateId: String(update.update_id),
    messageId: message.message_id,
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    text: message.text,
  };
}

/** The two APIs share their basic wire format; capabilities stay explicit per provider. */
function createProvider(
  name: Provider,
  baseUrl: string,
  request: Fetch,
): BotProvider {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} API base URL must be a trusted HTTPS URL`);
  }
  const endpoint = baseUrl.replace(/\/$/, "");
  async function call<T>(
    token: string,
    method: string,
    body: object,
  ): Promise<T> {
    try {
      const response = await request(`${endpoint}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      const data = (await response.json()) as any;
      if (!response.ok || !data.ok)
        throw new IntegrationError(
          "Provider request failed",
          response.status >= 400
            ? response.status
            : Number(data.error_code) || 502,
          Number(data.parameters?.retry_after) || 0,
          response.status === 401 || Number(data.error_code) === 401 ? "PROVIDER_TOKEN_INVALID" : method === "setWebhook" ? "PROVIDER_WEBHOOK_REJECTED" : "PROVIDER_REQUEST_REJECTED",
        );
      return data.result as T;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      // Native network errors can include credential-bearing URLs. Never expose them.
      throw new IntegrationError("Provider unavailable", 503, 0, "PROVIDER_UNREACHABLE");
    }
  }
  return {
    name,
    parseUpdate,
    async setup(token, webhookUrl, secret) {
      const me = await call<{ username: string }>(token, "getMe", {});
      if (!me.username || !/^[a-zA-Z0-9_]+$/.test(me.username))
        throw new IntegrationError("Provider returned invalid bot identity");
      const options =
        name === "telegram"
          ? {
              secret_token: secret,
              allowed_updates: ["message"],
              max_connections: 1,
            }
          : {};
      await call(token, "setWebhook", { url: webhookUrl, ...options });
      return me.username;
    },
    async send(token, chatId, text) {
      await call(token, "sendMessage", { chat_id: chatId, text });
    },
    async deleteMessage(token, chatId, messageId) {
      await call(token, "deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    },
    profileUrl: (username) =>
      `https://${name === "telegram" ? "t.me" : "ble.ir"}/${username}`,
    async preparePolling(token) {
      const me = await call<{ username: string }>(token, "getMe", {});
      if (!me.username || !/^[a-zA-Z0-9_]+$/.test(me.username)) throw new IntegrationError("Provider returned invalid bot identity");
      await call(token, "deleteWebhook", {});
      return me.username;
    },
    getUpdates: (token, offset) => call<unknown[]>(token, "getUpdates", { offset, limit: 50, timeout: 0 }),
  };
}
export function createProviders(
  request: Fetch = fetch,
  baseUrls: Partial<Record<Provider, string>> = {},
  transports: Partial<Record<Provider, Fetch>> = {},
): Record<Provider, BotProvider> {
  return {
    telegram: createProvider("telegram", baseUrls.telegram || "https://api.telegram.org", transports.telegram || request),
    bale: createProvider("bale", baseUrls.bale || "https://tapi.bale.ai", transports.bale || request),
  };
}
export const isProvider = (value: unknown): value is Provider =>
  value === "telegram" || value === "bale";

/** Optional messenger configuration must not prevent the other providers from starting. */
export function createConfiguredProviders(
  env: NodeJS.ProcessEnv,
  request: Fetch = fetch,
  warn: (message: string) => void = console.warn,
): { providers: Record<Provider, BotProvider>; close: () => Promise<void> } {
  const providers = {} as Record<Provider, BotProvider>;
  const closers: Array<() => Promise<void>> = [];
  for (const name of ["telegram", "bale"] as const) {
    const prefix = name.toUpperCase();
    try {
      const baseUrl = env[`${prefix}_API_BASE_URL`] || (name === "telegram" ? "https://api.telegram.org" : "https://tapi.bale.ai");
      const transport = createProviderTransport(env[`${prefix}_PROXY_URL`]);
      closers.push(transport.close);
      const direct = env[`${prefix}_PROXY_URL`]?.trim() ? transport.request : request;
      const configuredRequest = name === "telegram"
        ? createTelegramRelayTransport(direct, baseUrl, env.TELEGRAM_RELAY_API_KEY)
        : direct;
      providers[name] = createProvider(name, baseUrl, configuredRequest);
    } catch {
      // Never log raw errors: URL parsing errors may include credentials.
      const message = `${name} configuration invalid; check ${prefix}_API_BASE_URL, ${prefix}_PROXY_URL${name === "telegram" ? " and TELEGRAM_RELAY_API_KEY" : ""}, then restart the service`;
      warn(message);
      const unavailable = () => new IntegrationError(message, 503, 0, "PROVIDER_CONFIGURATION_INVALID");
      const reject = async (): Promise<never> => { throw unavailable(); };
      providers[name] = {
        name,
        // Return 503 for webhooks so updates are retried rather than silently dropped.
        parseUpdate: () => { throw unavailable(); },
        setup: reject, send: reject, deleteMessage: reject,
        preparePolling: reject, getUpdates: reject,
        profileUrl: username => `https://${name === "telegram" ? "t.me" : "ble.ir"}/${username}`,
      };
    }
  }
  return { providers, close: async () => { await Promise.allSettled(closers.map(close => close())); } };
}
