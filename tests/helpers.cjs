const { Connections } = require('../dist/storage/connections');
class MemoryStore {
  data = new Map();
  async get(key) { return this.data.get(key) ?? null; }
  async set(key, value, options = {}) {
    if (options.onlyIfAbsent && this.data.has(key)) return false;
    this.data.set(key, value); return true;
  }
  async scan(prefix) { return [...this.data.keys()].filter(key => key.startsWith(prefix)); }
  async delete(key) { this.data.delete(key); }
  async release(key, value) { if (this.data.get(key) === value) this.data.delete(key); }
}
function fixture() {
  const store = new MemoryStore(); const connections = new Connections(store, 'ab'.repeat(32));
  const calls = [];
  const provider = { name: 'telegram', parseUpdate: () => null, setup: async () => 'shop_bot',
    send: async (...args) => calls.push(args), deleteMessage: async () => {}, profileUrl: name => `https://t.me/${name}` };
  const providers = { telegram: provider, bale: { ...provider, name: 'bale' } };
  const connection = { id: connections.id('shop-a', 'telegram'), tenantId: 'shop-a', domain: 'pastelino.ir', provider: 'telegram', token: '123:private_bot_token_1234567890', webhookSecret: 'private-webhook', username: 'shop_bot' };
  return { store, connections, calls, provider, providers, connection };
}
module.exports = { MemoryStore, fixture };
