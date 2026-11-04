import { ProxyAgent, fetch as proxyFetch, RequestInit as ProxyRequestInit } from "undici";

/** Only attach relay credentials to the explicitly configured trusted HTTPS origin. */
export function createTelegramRelayTransport(request: typeof fetch, baseUrl?: string, apiKey?: string): typeof fetch {
  if (!apiKey) return request;
  if (!baseUrl || apiKey.length < 32 || /\s/.test(apiKey)) throw new Error("Telegram relay requires a trusted HTTPS base URL and a key of at least 32 characters without whitespace");
  const relay = new URL(baseUrl);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash || relay.origin === "https://api.telegram.org") {
    throw new Error("Telegram relay key requires a custom trusted HTTPS API base URL");
  }
  return (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== relay.origin) throw new Error("Telegram relay origin mismatch");
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${apiKey}`);
    return request(input, { ...init, headers, redirect: "error" });
  };
}

/** Proxy only messenger traffic; Redis, PostgreSQL and shop APIs keep their own routes. */
export function createProviderTransport(proxyUrl?: string): { request: typeof fetch; close: () => Promise<void> } {
  if (!proxyUrl?.trim()) return { request: fetch, close: async () => {} };
  const url = new URL(proxyUrl.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Provider proxy must be an HTTP CONNECT proxy URL; use V2Ray's HTTP/mixed listener, not a SOCKS-only port");
  }
  const agent = new ProxyAgent(proxyUrl.trim());
  const request: typeof fetch = (input, init) => proxyFetch(input as Parameters<typeof proxyFetch>[0], {
    ...(init as ProxyRequestInit), dispatcher: agent,
  }) as unknown as ReturnType<typeof fetch>;
  return { request, close: () => agent.close() };
}
