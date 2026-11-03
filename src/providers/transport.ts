import { ProxyAgent, fetch as proxyFetch, RequestInit as ProxyRequestInit } from "undici";

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
