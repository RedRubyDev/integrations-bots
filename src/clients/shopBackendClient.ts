import { Connection, IntegrationError, ShopBackend, ShopApiResult as ApiResult } from "../contracts";
import { normalizeDomain, tenantServiceKey } from "../domain";
import { UserSessions, UserSession } from "../storage/userSessions";

type ApiResponse<T = unknown> = { status: number; result: ApiResult<T> };

/** Uses the same login, refresh and permission-protected APIs as the admin panel. */
export class ShopBackendClient implements ShopBackend {
  private readonly localBackend: boolean;
  constructor(
    private readonly urlTemplate: string,
    private readonly apiKey: string,
    private readonly sessions: UserSessions,
    private readonly request: typeof fetch = fetch,
  ) {
    const sample = new URL(urlTemplate.replace("{domain}", "shop.example"));
    this.localBackend = process.env.NODE_ENV !== "production" && !urlTemplate.includes("{domain}") && sample.protocol === "http:" && ["localhost", "127.0.0.1"].includes(sample.hostname);
    if ((!this.localBackend && (sample.protocol !== "https:" || !urlTemplate.includes("{domain}"))) || sample.pathname !== "/" || sample.username || sample.password || sample.search || sample.hash) {
      throw new Error("SHOP_BACKEND_URL_TEMPLATE must be an HTTPS backend origin containing {domain}, without an API path");
    }
  }

  private async call<T>(connection: Connection, method: string, path: string, body?: object, accessToken?: string): Promise<ApiResponse<T>> {
    if (normalizeDomain(connection.domain, this.localBackend) !== connection.domain || !path.startsWith("/api/") || path.includes("..") || path.includes("\\")) {
      throw new IntegrationError("Invalid shop API request", 400);
    }
    const origin = this.urlTemplate.replace("{domain}", connection.domain).replace(/\/$/, "");
    const target = new URL(path, origin);
    if (target.origin !== new URL(origin).origin || !target.pathname.startsWith("/api/")) throw new IntegrationError("Invalid shop API request", 400);
    try {
      const response = await this.request(target.href, {
        method,
        headers: {
          "Content-Type": "application/json",
          "application-name": "adminpanel",
          ...(target.pathname.startsWith("/api/bots/") ? { "X-Bot-Service-Key": tenantServiceKey(this.apiKey, connection.tenantId) } : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error", signal: AbortSignal.timeout(10000),
      });
      const result = await response.json() as ApiResult<T>;
      return { status: response.status, result };
    } catch {
      // Never expose credential-bearing fetch errors or response bodies in exceptions.
      throw new IntegrationError("Shop backend unavailable", 503, 0, "SHOP_BACKEND_UNREACHABLE");
    }
  }

  async verify(connection: Connection): Promise<void> {
    const { status, result } = await this.call<{ tenantId: string; domain: string }>(connection, "POST", "/api/bots/service/context", { tenantId: connection.tenantId, provider: connection.provider });
    if (status >= 500) throw new IntegrationError("Shop backend unavailable", 503, 0, "SHOP_BACKEND_UNREACHABLE");
    if (status === 401) throw new IntegrationError("Shop service authentication failed", 401, 0, "SHOP_SERVICE_AUTH_FAILED");
    if (status !== 200 || !result.isSuccess || result.data?.tenantId !== connection.tenantId || normalizeDomain(result.data.domain || "", this.localBackend) !== connection.domain) {
      throw new IntegrationError("Shop domain verification failed", 403, 0, "SHOP_DOMAIN_MISMATCH");
    }
  }

  async authenticate(connection: Connection, input: { externalUserId: string; chatId: string; username: string; password: string }): Promise<boolean> {
    const login = await this.call<UserSession>(connection, "POST", "/api/users/login", { username: input.username, password: input.password });
    if (login.status >= 500 || login.status === 429) throw new IntegrationError("Shop login unavailable", login.status);
    if (login.status !== 200 || !login.result.isSuccess || !this.validTokens(login.result.data)) return false;
    await this.sessions.save(connection, input.externalUserId, login.result.data);
    try {
      const link = await this.requestForUser(connection, input.externalUserId, "POST", "/api/bots/account/link", {
        provider: connection.provider, connectionId: connection.id, externalUserId: input.externalUserId, chatId: input.chatId,
      });
      if (!link.isSuccess) { await this.sessions.remove(connection, input.externalUserId); return false; }
      return true;
    } catch (error) {
      await this.sessions.remove(connection, input.externalUserId);
      if (error instanceof IntegrationError && [401, 403].includes(error.status)) return false;
      throw error;
    }
  }

  /** Public customer registration remains the backend's normal registration flow. It never grants admin access. */
  async register(connection: Connection, input: { phoneNumber: string; password: string }): Promise<ApiResult> {
    const response = await this.call(connection, "POST", "/api/users/register", input);
    if (response.status >= 500) throw new IntegrationError("Shop registration unavailable");
    return response.result;
  }

  /** Reusable by future order/product/stock commands; backend RBAC remains authoritative. */
  async requestForUser<T = unknown>(connection: Connection, externalUserId: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: object): Promise<ApiResult<T>> {
    let session = await this.sessions.get(connection, externalUserId);
    if (!session) throw new IntegrationError("Shop login required", 401);
    let response = await this.call<T>(connection, method, path, body, session.accessToken);
    if (response.status === 401) {
      session = await this.refresh(connection, externalUserId, session);
      response = await this.call<T>(connection, method, path, body, session.accessToken);
    }
    if (response.status === 401) await this.sessions.remove(connection, externalUserId);
    if (response.status >= 400) throw new IntegrationError("Shop API request rejected", response.status);
    return response.result;
  }

  private validTokens(value: unknown): value is UserSession {
    const tokens = value as UserSession | undefined;
    return typeof tokens?.accessToken === "string" && Boolean(tokens.accessToken) && typeof tokens.refreshToken === "string" && Boolean(tokens.refreshToken);
  }
  private async refresh(connection: Connection, externalUserId: string, session: UserSession): Promise<UserSession> {
    const response = await this.call<UserSession>(connection, "POST", "/api/users/refresh-token", {}, session.refreshToken);
    if (response.status >= 500 || response.status === 429) throw new IntegrationError("Shop session refresh unavailable", response.status);
    if (response.status !== 200 || !response.result.isSuccess || !this.validTokens(response.result.data)) {
      await this.sessions.remove(connection, externalUserId);
      throw new IntegrationError("Shop login required", 401);
    }
    await this.sessions.save(connection, externalUserId, response.result.data);
    return response.result.data;
  }
  async unlink(connection: Connection, externalUserId: string): Promise<void> {
    await this.requestForUser(connection, externalUserId, "POST", "/api/bots/account/unlink", { provider: connection.provider, connectionId: connection.id, externalUserId });
    await this.sessions.remove(connection, externalUserId);
  }
  async status(connection: Connection, externalUserId: string): Promise<boolean> {
    if (!await this.sessions.get(connection, externalUserId)) return false;
    try {
      const result = await this.requestForUser<{ linked: boolean }>(connection, externalUserId, "POST", "/api/bots/account/status", { provider: connection.provider, connectionId: connection.id, externalUserId });
      return Boolean(result.data?.linked);
    } catch (error) {
      if (error instanceof IntegrationError && [401, 403].includes(error.status)) return false;
      throw error;
    }
  }
}
