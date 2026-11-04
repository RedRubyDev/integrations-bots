const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramRelay } = require('../scripts/telegram-relay.cjs');
const { createTelegramRelayTransport } = require('../dist/providers/transport');
const { createProviders } = require('../dist/providers/registry');
const { createConfiguredProviders } = require('../dist/providers/registry');
const key = 'relay-test-key-'.repeat(3);

async function withRelay(request, run) {
  const server = createTelegramRelay({ apiKey: key, request });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = '{}', headers = {}) => fetch(url + path, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body,
  });
  try { await run(post); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('standalone relay forwards only to Telegram and preserves rate-limit responses', async () => {
  await withRelay(async (url, init) => {
    assert.equal(url, 'https://api.telegram.org/bot123:TEST/sendMessage');
    assert.deepEqual(JSON.parse(init.body), { chat_id: '12', text: 'سلام' });
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'error');
    return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 });
  }, async post => {
    const res = await post('/bot123:TEST/sendMessage', JSON.stringify({ chat_id: '12', text: 'سلام' }));
    assert.equal(res.status, 429);
    assert.equal((await res.json()).parameters.retry_after, 5);
  });
});

test('relay rejects unauthenticated, arbitrary, malformed and oversized requests without upstream calls', async () => {
  await withRelay(() => { assert.fail('Unexpected upstream call'); }, async post => {
    assert.equal((await post('/bot123:TEST/getMe', '{}', { authorization: 'Bearer wrong' })).status, 401);
    for (const path of ['/https://evil.example', '/bot123:TEST/getMe?url=https://evil.example', '/bot123:TEST/a/b']) {
      assert.equal((await post(path)).status, 404);
    }
    assert.equal((await post('/bot123:TEST/getMe', '{')).status, 400);
    assert.equal((await post('/bot123:TEST/getMe', '[]')).status, 400);
    assert.equal((await post('/bot123:TEST/getMe', '{}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('/bot123:TEST/getMe', JSON.stringify({ text: 'x'.repeat(1024 * 1024) }))).status, 413);
  });
});

test('relay returns safe errors on network failure', async () => {
  await withRelay(() => { throw new Error('secret bot123:TEST'); }, async post => {
    const res = await post('/bot123:TEST/getMe');
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('TEST'));
  });
  assert.throws(() => createTelegramRelay({ apiKey: 'short' }));
});

test('integration sends Telegram through authenticated relay and keeps Bale separate', async () => {
  let relayCalls = 0;
  let directCalls = 0;
  const transport = createTelegramRelayTransport(async (url, init) => {
    assert.equal(url, 'https://relay.example/bot123:TEST/sendMessage');
    assert.equal(init.headers.get('Authorization'), `Bearer ${key}`);
    assert.equal(init.redirect, 'error');
    relayCalls++;
    return Response.json({ ok: true, result: true });
  }, 'https://relay.example', key);
  const providers = createProviders(async () => {
    directCalls++;
    return Response.json({ ok: true, result: true });
  }, { telegram: 'https://relay.example' }, { telegram: transport });
  await providers.telegram.send('123:TEST', '12', 'سلام');
  await providers.bale.send('123:TEST', '12', 'سلام');
  assert.equal(relayCalls, 1);
  assert.equal(directCalls, 1);
  assert.throws(() => transport('https://evil.example', {}));
  assert.throws(() => createTelegramRelayTransport(fetch, 'http://relay.example', key));
  assert.throws(() => createTelegramRelayTransport(fetch, 'https://api.telegram.org', key));
  assert.equal(createTelegramRelayTransport(fetch), fetch);
});

test('invalid provider configuration is isolated without network fallback or secret logs', async () => {
  const cases = [
    { TELEGRAM_RELAY_API_KEY: key },
    { TELEGRAM_API_BASE_URL: 'http://relay.example', TELEGRAM_RELAY_API_KEY: key },
    { TELEGRAM_API_BASE_URL: 'not-a-url-SECRET', TELEGRAM_RELAY_API_KEY: key },
    { TELEGRAM_API_BASE_URL: 'https://user:SECRET@relay.example', TELEGRAM_RELAY_API_KEY: key },
    { TELEGRAM_API_BASE_URL: 'https://relay.example', TELEGRAM_RELAY_API_KEY: 'short' },
    { TELEGRAM_PROXY_URL: 'socks5://localhost:1234' },
  ];
  for (const env of cases) {
    const warnings = [];
    let calls = 0;
    const runtime = createConfiguredProviders(env, async () => {
      calls++;
      return Response.json({ ok: true, result: true });
    }, message => warnings.push(message));
    try {
      for (const action of [
        () => runtime.providers.telegram.send('123:SECRET', '12', 'text'),
        () => runtime.providers.telegram.setup('123:SECRET', 'https://callback.example', 'secret'),
        () => runtime.providers.telegram.getUpdates('123:SECRET', 0),
        () => runtime.providers.telegram.deleteMessage('123:SECRET', '12', 1),
      ]) {
        await assert.rejects(action, error => error.code === 'PROVIDER_CONFIGURATION_INVALID' && error.status === 503);
      }
      assert.throws(() => runtime.providers.telegram.parseUpdate({}), error => error.code === 'PROVIDER_CONFIGURATION_INVALID');
      assert.equal(calls, 0);
      await runtime.providers.bale.send('123:TEST', '12', 'text');
      assert.equal(calls, 1);
      assert.equal(warnings.length, 1);
      assert.ok(!warnings[0].includes('SECRET'));
      assert.ok(!warnings[0].includes(key));
    } finally { await runtime.close(); }
  }
});

test('HTTP service stays live with broken relay config; Telegram returns 503 and Bale sends', async () => {
  const { fixture } = require('./helpers.cjs');
  const { createApp } = require('../dist/http/app');
  const { MessageService } = require('../dist/services/messageService');
  const { tenantServiceKey } = require('../dist/domain');
  const f = fixture();
  const runtime = createConfiguredProviders({ TELEGRAM_RELAY_API_KEY: key }, async () => Response.json({ ok: true, result: true }), () => {});
  await f.connections.save(f.connection);
  await f.connections.save({ ...f.connection, id: f.connections.id('shop-a', 'bale'), provider: 'bale' });
  const app = createApp({ ...f, providers: runtime.providers, apiKey: 'service-key',
    conversation: { handle: async () => assert.fail('Disabled webhook must not be processed') },
    messages: new MessageService(f.store, f.connections, runtime.providers) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const send = provider => fetch(`${base}/v1/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${tenantServiceKey('service-key', 'shop-a')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'shop-a', provider, chatId: '12', text: 'hello' }) });
    const failed = await send('telegram');
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, 'PROVIDER_CONFIGURATION_INVALID');
    assert.equal((await send('bale')).status, 200);
    assert.equal((await fetch(`${base}/webhooks/${f.connection.id}/${f.connection.webhookSecret}`, {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': f.connection.webhookSecret, 'Content-Type': 'application/json' }, body: '{}',
    })).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await runtime.close();
  }
});
