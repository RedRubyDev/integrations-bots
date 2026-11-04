const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramRelay } = require('../scripts/telegram-relay.cjs');
const { createTelegramRelayTransport } = require('../dist/providers/transport');
const { createProviders } = require('../dist/providers/registry');
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
