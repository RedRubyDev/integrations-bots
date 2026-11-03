const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers.cjs');
const { createApp } = require('../dist/http/app');
const { MessageService } = require('../dist/services/messageService');
const { tenantServiceKey } = require('../dist/domain');
const authorization = `Bearer ${tenantServiceKey('service-key', 'shop-a')}`;

async function withServer(run) {
  const f = fixture(); await f.connections.save(f.connection);
  let handled = 0;
  f.provider.parseUpdate = () => ({ updateId: '1', userId: '123', chatId: '123', messageId: 1, text: '/start' });
  const app = createApp({ ...f, apiKey: 'service-key', connectionService: { configure: async () => ({ connectionId: f.connection.id }) },
    conversation: { handle: async () => { handled++; } }, messages: new MessageService(f.store, f.connections, f.providers) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ ...f, base, handled: () => handled }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('send API rejects missing credentials and invalid providers', async () => withServer(async f => {
  assert.equal((await fetch(`${f.base}/v1/messages`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: 'shop-a', provider: '__proto__' }) })).status, 422);
  assert.equal(f.calls.length, 0);
}));
test('generic send API supports arbitrary text and deduplicates requests', async () => withServer(async f => {
  const body = { tenantId: 'shop-a', provider: 'telegram', chatId: '123', text: 'A custom notification', idempotencyKey: 'custom-1' };
  const send = () => fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send()).status, 200);
  assert.equal((await (await send()).json()).data.duplicate, true);
  assert.equal(f.calls.length, 1);
}));
test('a tenant credential cannot send messages for another shop', async () => withServer(async f => {
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: 'shop-b', provider: 'telegram', chatId: '123', text: 'Private order' }) });
  assert.equal(response.status, 401); assert.equal(f.calls.length, 0);
}));
test('webhooks require connection-bound secrets and ignore duplicate updates', async () => withServer(async f => {
  const url = `${f.base}/webhooks/${f.connection.id}/${f.connection.webhookSecret}`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const post = () => fetch(url, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': f.connection.webhookSecret, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await post()).status, 200); assert.equal((await post()).status, 200);
  assert.equal(f.handled(), 1);
  assert.equal((await fetch(url.replace(f.connection.webhookSecret, 'another-secret'), { method: 'POST' })).status, 401);
}));
