const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers.cjs");
const { createProviders } = require("../dist/providers/registry");
const { ConnectionService } = require("../dist/services/connectionService");
const { ConversationService } = require("../dist/services/conversationService");
const { MessageService } = require("../dist/services/messageService");
const { normalizeDomain } = require("../dist/domain");

for (const name of ["telegram", "bale"]) {
  test(`${name}: provider owns API calls and respects its webhook capabilities`, async () => {
    const requests = [];
    const providers = createProviders(async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { username: "shop_bot" } }),
      };
    });
    await providers[name].setup("TOKEN", "https://bots.test/hook", "SECRET");
    await providers[name].send("TOKEN", "123", "Message");
    const host =
      name === "telegram" ? "https://api.telegram.org" : "https://tapi.bale.ai";
    assert.equal(requests[2].url, `${host}/botTOKEN/sendMessage`);
    assert.equal(
      requests[1].body.secret_token,
      name === "telegram" ? "SECRET" : undefined,
    );
    assert.equal(
      providers[name].parseUpdate({
        update_id: 1,
        message: {
          message_id: 2,
          from: { id: 3 },
          chat: { id: -1, type: "group" },
          text: "secret",
        },
      }),
      null,
    );
  });
}
test("provider errors never expose token-bearing URLs or request bodies", async () => {
  const providers = createProviders(async () => {
    throw new Error("https://api.telegram.org/botPRIVATE_TOKEN password");
  });
  await assert.rejects(
    providers.telegram.send("PRIVATE_TOKEN", "123", "password"),
    (error) =>
      error.message === "Provider unavailable" &&
      !JSON.stringify(error).includes("PRIVATE_TOKEN"),
  );
});
test("bot credentials are encrypted and token ownership cannot cross shops", async () => {
  const f = fixture();
  await f.connections.save(f.connection);
  assert.ok(!JSON.stringify([...f.store.data]).includes(f.connection.token));
  assert.deepEqual(await f.connections.get(f.connection.id), f.connection);
  await f.connections.claim("telegram", f.connection.token, "shop-a");
  await assert.rejects(
    f.connections.claim("telegram", f.connection.token, "shop-b"),
    { status: 409 },
  );
});
test("message API is idempotent and tenant scoped", async () => {
  const f = fixture();
  await f.connections.save(f.connection);
  const service = new MessageService(f.store, f.connections, f.providers);
  const message = {
    tenantId: "shop-a",
    provider: "telegram",
    chatId: "123",
    text: "Order paid",
    idempotencyKey: "order-1",
  };
  assert.deepEqual(await service.send(message), { duplicate: false });
  assert.deepEqual(await service.send(message), { duplicate: true });
  assert.equal(f.calls.length, 1);
  await assert.rejects(service.send({ ...message, tenantId: "shop-b" }), {
    status: 409,
  });
  await assert.rejects(service.send({ ...message, text: "Another message" }), {
    status: 422,
  });
});
test("connection setup verifies the shop via API before registering a webhook", async () => {
  const f = fixture();
  const operations = [];
  f.provider.setup = async () => {
    operations.push("provider");
    return "shop_bot";
  };
  const service = new ConnectionService(
    f.connections,
    f.store,
    f.providers,
    { verify: async () => operations.push("backend") },
    "https://bots.test",
  );
  const result = await service.configure(f.connection);
  assert.deepEqual(operations, ["backend", "provider"]);
  assert.equal(result.connectionId, f.connection.id);
  assert.ok(!JSON.stringify(result).includes(f.connection.token));
});
test("failed shop verification never configures a provider", async () => {
  const f = fixture();
  let configured = false;
  f.provider.setup = async () => {
    configured = true;
  };
  const service = new ConnectionService(
    f.connections,
    f.store,
    f.providers,
    {
      verify: async () => {
        throw new Error("unavailable");
      },
    },
    "https://bots.test",
  );
  await assert.rejects(service.configure(f.connection));
  assert.equal(configured, false);
});
test("conversation delegates authentication to shop API and stores no password", async () => {
  const f = fixture();
  const operations = [];
  let credentials;
  f.provider.deleteMessage = async () => operations.push("deleted");
  const backend = {
    verify: async () => operations.push("verified"),
    authenticate: async (_connection, input) => {
      operations.push("authenticated");
      credentials = input;
      return true;
    },
  };
  const service = new ConversationService(f.store, backend);
  let id = 0;
  const send = (text) =>
    service.handle(f.connection, f.provider, {
      updateId: String(++id),
      messageId: id,
      userId: "123",
      chatId: "123",
      text,
    });
  await send("/start");
  await send("wrong-shop.ir");
  assert.equal(operations.length, 0);
  await send("pastelino.ir");
  await send("admin");
  await send("PRIVATE_PASSWORD");
  assert.deepEqual(operations, ["verified", "deleted", "authenticated"]);
  assert.equal(credentials.password, "PRIVATE_PASSWORD");
  assert.ok(!JSON.stringify([...f.store.data]).includes("PRIVATE_PASSWORD"));
  assert.equal(f.store.data.size, 0);
});
test("password deletion failure prevents shop authentication", async () => {
  const f = fixture();
  let authenticated = false;
  f.provider.deleteMessage = async () => {
    throw new Error("cannot delete");
  };
  const service = new ConversationService(f.store, {
    verify: async () => {},
    authenticate: async () => {
      authenticated = true;
      return true;
    },
  });
  await f.store.set(
    `session:${f.connection.id}:123`,
    JSON.stringify({ step: "password", username: "admin" }),
  );
  await assert.rejects(
    service.handle(f.connection, f.provider, {
      updateId: "1",
      messageId: 1,
      userId: "123",
      chatId: "123",
      text: "PRIVATE_PASSWORD",
    }),
  );
  assert.equal(authenticated, false);
});
test("domain parsing rejects credentials, ports, paths and numeric local addresses", () => {
  for (const domain of [
    "https://user:pass@pastelino.ir",
    "pastelino.ir/other",
    "pastelino.ir:80",
    "127.0.0.1",
    "file:///tmp",
  ])
    assert.equal(normalizeDomain(domain), null);
  assert.equal(normalizeDomain("https://www.PASTELINO.IR/"), "pastelino.ir");
});
