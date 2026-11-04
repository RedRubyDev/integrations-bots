const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers.cjs');
const { ShopBackendClient } = require('../dist/clients/shopBackendClient');
const { UserSessions } = require('../dist/storage/userSessions');
const { tenantServiceKey } = require('../dist/domain');
const { createProviders } = require('../dist/providers/registry');

function setup(responses) {
  const f = fixture(); const requests = [];
  const sessions = new UserSessions(f.store, 'ab'.repeat(32));
  const client = new ShopBackendClient('https://api.{domain}', 'MASTER_KEY', sessions, async (url, options) => {
    requests.push({ url, options });
    const response = responses.shift();
    assert.ok(response, 'Unexpected API request');
    return { status: response.status || 200, json: async () => response.result };
  });
  return { ...f, sessions, client, requests };
}
const tokens = { accessToken: 'PRIVATE_ACCESS_TOKEN', refreshToken: 'PRIVATE_REFRESH_TOKEN' };
const identity = { externalUserId: '123', chatId: '123', username: 'admin', password: 'PRIVATE_PASSWORD' };

test('plain-text backend errors preserve their HTTP status during setup', async () => {
  const f = fixture();
  const sessions = new UserSessions(f.store, 'ab'.repeat(32));
  for (const [status, code] of [[401, 'SHOP_SERVICE_AUTH_FAILED'], [403, 'SHOP_DOMAIN_MISMATCH'], [503, 'SHOP_BACKEND_UNREACHABLE']]) {
    const client = new ShopBackendClient('https://api.{domain}', 'MASTER_KEY', sessions,
      async () => new Response('Sensitive upstream error', { status }));
    await assert.rejects(client.verify(f.connection), error => error.code === code && !error.message.includes('Sensitive'));
  }
});

test('invalid successful backend responses are distinguished from network failures', async () => {
  const f = fixture();
  const sessions = new UserSessions(f.store, 'ab'.repeat(32));
  for (const body of ['<html>wrong server</html>', 'null', '{}']) {
    const client = new ShopBackendClient('https://api.{domain}', 'MASTER_KEY', sessions,
      async () => new Response(body));
    await assert.rejects(client.verify(f.connection), { code: 'SHOP_BACKEND_INVALID_RESPONSE' });
  }
  const client = new ShopBackendClient('https://api.{domain}', 'MASTER_KEY', sessions,
    async () => { throw new Error('private connection data'); });
  await assert.rejects(client.verify(f.connection), { code: 'SHOP_BACKEND_UNREACHABLE' });
});
test('uses normal login then links identity with normal bearer token; all stored tokens are encrypted', async () => {
  const f = setup([{ result: { isSuccess: true, data: tokens } }, { result: { isSuccess: true } }]);
  assert.equal(await f.client.authenticate(f.connection, identity), true);
  assert.equal(f.requests[0].url, 'https://api.pastelino.ir/api/users/login');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { username: 'admin', password: 'PRIVATE_PASSWORD' });
  assert.equal(f.requests[0].options.headers['X-Bot-Service-Key'], undefined);
  assert.equal(f.requests[1].url, 'https://api.pastelino.ir/api/bots/account/link');
  assert.equal(f.requests[1].options.headers.Authorization, 'Bearer PRIVATE_ACCESS_TOKEN');
  assert.equal(f.requests[1].options.headers['X-Bot-Service-Key'], tenantServiceKey('MASTER_KEY', 'shop-a'));
  assert.ok(!f.requests[1].options.body.includes('PRIVATE_PASSWORD'));
  for (const secret of [...Object.values(tokens), 'PRIVATE_PASSWORD']) assert.ok(!JSON.stringify([...f.store.data]).includes(secret));
});
test('invalid ordinary login does not store a session or call a bot authentication route', async () => {
  const f = setup([{ status: 400, result: { isSuccess: false } }]);
  assert.equal(await f.client.authenticate(f.connection, identity), false);
  assert.equal(f.requests.length, 1); assert.equal(await f.sessions.get(f.connection, '123'), null);
});
test('future shop commands use ordinary APIs, refreshing standard tokens once on expiry', async () => {
  const f = setup([
    { status: 401, result: { isSuccess: false } },
    { result: { isSuccess: true, data: { accessToken: 'NEW_ACCESS', refreshToken: 'NEW_REFRESH' } } },
    { result: { isSuccess: true, data: [{ id: 1 }] } },
  ]);
  await f.sessions.save(f.connection, '123', tokens);
  assert.deepEqual((await f.client.requestForUser(f.connection, '123', 'GET', '/api/products')).data, [{ id: 1 }]);
  assert.equal(f.requests[1].url, 'https://api.pastelino.ir/api/users/refresh-token');
  assert.equal(f.requests[1].options.headers.Authorization, 'Bearer PRIVATE_REFRESH_TOKEN');
  assert.equal(f.requests[2].options.headers.Authorization, 'Bearer NEW_ACCESS');
  assert.equal(f.requests[2].options.headers['X-Bot-Service-Key'], undefined);
  assert.equal((await f.sessions.get(f.connection, '123')).refreshToken, 'NEW_REFRESH');
});
test('shop permission denial is preserved and never bypassed with service credentials', async () => {
  const f = setup([{ status: 403, result: { isSuccess: false } }]);
  await f.sessions.save(f.connection, '123', tokens);
  await assert.rejects(f.client.requestForUser(f.connection, '123', 'DELETE', '/api/products/1'), { status: 403 });
  assert.equal(f.requests.length, 1);
});
test('invalid refresh requires login again and clears the encrypted session', async () => {
  const f = setup([{ status: 401, result: {} }, { status: 401, result: { isSuccess: false } }]);
  await f.sessions.save(f.connection, '123', tokens);
  await assert.rejects(f.client.requestForUser(f.connection, '123', 'GET', '/api/orders'), { status: 401 });
  assert.equal(await f.sessions.get(f.connection, '123'), null);
});
test('ordinary register is reused and cannot implicitly create an admin', async () => {
  const f = setup([{ result: { isSuccess: true } }]);
  await f.client.register(f.connection, { phoneNumber: '09123456789', password: 'PRIVATE_PASSWORD' });
  assert.equal(f.requests[0].url, 'https://api.pastelino.ir/api/users/register');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { phoneNumber: '09123456789', password: 'PRIVATE_PASSWORD' });
  assert.equal(await f.sessions.get(f.connection, '123'), null);
});
test('custom provider URLs are independent and reject insecure endpoints', async () => {
  const requests = [];
  const providers = createProviders(async (url) => { requests.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }; },
    { telegram: 'https://telegram-proxy.example/', bale: 'https://bale-proxy.example' });
  await providers.telegram.send('TOKEN', '123', 'hello'); await providers.bale.send('TOKEN', '123', 'hello');
  assert.deepEqual(requests, ['https://telegram-proxy.example/botTOKEN/sendMessage', 'https://bale-proxy.example/botTOKEN/sendMessage']);
  assert.throws(() => createProviders(fetch, { bale: 'http://bale-proxy.example' }));
});
