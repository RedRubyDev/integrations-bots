export type Provider = "telegram" | "bale";
export type Connection = {
  id: string;
  tenantId: string;
  domain: string;
  provider: Provider;
  token: string;
  webhookSecret: string;
  username: string;
  updateMode?: "webhook" | "polling";
};
export type IncomingMessage = {
  updateId: string;
  userId: string;
  chatId: string;
  messageId: number;
  text: string;
};
export interface BotProvider {
  name: Provider;
  parseUpdate(value: unknown): IncomingMessage | null;
  setup(token: string, webhookUrl: string, secret: string): Promise<string>;
  send(token: string, chatId: string, text: string): Promise<void>;
  deleteMessage(
    token: string,
    chatId: string,
    messageId: number,
  ): Promise<void>;
  profileUrl(username: string): string;
  preparePolling(token: string): Promise<string>;
  getUpdates(token: string, offset: number): Promise<unknown[]>;
}
export interface Store {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { ttl?: number; onlyIfAbsent?: boolean },
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
  release(key: string, value: string): Promise<void>;
  scan(prefix: string): Promise<string[]>;
}
export interface ShopBackend {
  register(connection: Connection, input: { phoneNumber: string; password: string }): Promise<ShopApiResult>;
  requestForUser<T = unknown>(connection: Connection, externalUserId: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: object): Promise<ShopApiResult<T>>;
  verify(connection: Connection): Promise<void>;
  authenticate(
    connection: Connection,
    input: {
      externalUserId: string;
      chatId: string;
      username: string;
      password: string;
    },
  ): Promise<boolean>;
  unlink(connection: Connection, externalUserId: string): Promise<void>;
  status(connection: Connection, externalUserId: string): Promise<boolean>;
}
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 503,
    readonly retryAfter = 0,
    readonly code = "INTEGRATION_REQUEST_FAILED",
  ) {
    super(message);
  }
}
export type ShopApiResult<T = unknown> = { isSuccess: boolean; message?: string; data?: T };
