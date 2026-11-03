import { UpdateProcessor } from "../services/updateProcessor";
import express from "express";
import { randomUUID } from "crypto";
import { Connections } from "../storage/connections";
import { BotProvider, IntegrationError, Provider, Store } from "../contracts";
import { secretsEqual, tenantServiceKey } from "../domain";
import { isProvider } from "../providers/registry";
import { ConnectionService } from "../services/connectionService";
import { ConversationService } from "../services/conversationService";
import { MessageService } from "../services/messageService";

type Dependencies = {
  apiKey: string;
  store: Store;
  connections: Connections;
  providers: Record<Provider, BotProvider>;
  connectionService: ConnectionService;
  conversation: ConversationService;
  messages: MessageService;
};
const validString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function createApp(deps: Dependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  const processor = new UpdateProcessor(deps.store, deps.providers, deps.conversation);
  app.post("/webhooks/:id/:secret", async (req, res) => {
    try {
      const connection = await deps.connections.get(req.params.id);
      if (!connection || connection.updateMode === "polling" || !secretsEqual(req.params.secret, connection.webhookSecret) ||
        (connection.provider === "telegram" && !secretsEqual(req.get("X-Telegram-Bot-Api-Secret-Token") || "", connection.webhookSecret))) {
        res.sendStatus(401); return;
      }
      await processor.process(connection, req.body);
      res.sendStatus(200);
    } catch { res.sendStatus(503); }
  });
  app.use("/v1", (req, res, next) => {
    const tenantId = req.body?.tenantId;
    if (
      typeof tenantId !== "string" ||
      !tenantId ||
      tenantId.length > 128 ||
      !secretsEqual(
        req.get("Authorization") || "",
        `Bearer ${tenantServiceKey(deps.apiKey, tenantId)}`,
      )
    ) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.post("/v1/connections", async (req, res, next) => {
    try {
      const { tenantId, domain, provider, token } = req.body || {};
      if (
        !validString(tenantId, 128) ||
        !validString(domain, 253) ||
        !isProvider(provider) ||
        !validString(token, 256)
      )
        throw new IntegrationError("Invalid connection", 422);
      res.json({
        isSuccess: true,
        data: await deps.connectionService.configure({
          tenantId,
          domain,
          provider,
          token,
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/v1/messages", async (req, res, next) => {
    try {
      const {
        tenantId,
        provider,
        chatId,
        text,
        idempotencyKey = randomUUID(),
      } = req.body || {};
      if (
        !validString(tenantId, 128) ||
        !isProvider(provider) ||
        !validString(chatId, 128) ||
        !/^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(chatId) ||
        !validString(text, 4096) ||
        !validString(idempotencyKey, 256)
      )
        throw new IntegrationError("Invalid message", 422);
      res.json({
        isSuccess: true,
        data: await deps.messages.send({
          tenantId,
          provider,
          chatId,
          text,
          idempotencyKey,
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const known = error instanceof IntegrationError;
      const status = known
        ? error.status
        : error instanceof SyntaxError
          ? 400
          : 503;
      const retryAfter = known ? error.retryAfter : 0;
      if (retryAfter) res.set("Retry-After", String(retryAfter));
      // No raw errors, request bodies, URL paths or passwords in logs or responses.
      res
        .status(status)
        .json({
          isSuccess: false,
          message: known ? error.message : "Integration request failed",
          retryAfter,
          code: known ? error.code : "INTEGRATION_REQUEST_FAILED",
        });
    },
  );
  return app;
}
