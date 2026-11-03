const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers.cjs');
const { ConnectionService } = require('../dist/services/connectionService');
const { ShopBackendClient } = require('../dist/clients/shopBackendClient');
const { UserSessions } = require('../dist/storage/userSessions');
const { UpdateProcessor } = require('../dist/services/updateProcessor');
const { startPolling } = require('../dist/services/pollingWorker');
const flush = async (predicate) => { for (let i=0;i<100;i++) { if(predicate()) return; await new Promise(resolve=>setImmediate(resolve)); } assert.fail('Polling did not finish'); };

test('local polling setup accepts localhost without registering a public webhook', async () => {
  const f = fixture(); let polling = 0; let webhook = 0;
  f.provider.preparePolling = async () => { polling++; return 'shop_bot'; };
  f.provider.setup = async () => { webhook++; return 'shop_bot'; };
  const service = new ConnectionService(f.connections,f.store,f.providers,{verify:async()=>{}},'', 'polling');
  const result = await service.configure({...f.connection, domain:'localhost'});
  assert.equal(polling,1); assert.equal(webhook,0);
  assert.equal((await f.connections.get(result.connectionId)).updateMode,'polling');
});
test('webhook mode reports placeholder callback configuration explicitly', async () => {
  const f = fixture();
  const service = new ConnectionService(f.connections,f.store,f.providers,{verify:async()=>{}},'https://bots.example.com');
  await assert.rejects(service.configure(f.connection),{code:'PUBLIC_WEBHOOK_REQUIRED'});
});
test('local backend access is loopback-only and is rejected in production', async () => {
  const f = fixture(); const sessions = new UserSessions(f.store,'ab'.repeat(32)); let target;
  const client = new ShopBackendClient('http://localhost:3000','KEY',sessions,async url=>{target=url;return {status:200,json:async()=>({isSuccess:true,data:{tenantId:'shop-a',domain:'localhost'}})};});
  await client.verify({...f.connection,domain:'localhost'});
  assert.equal(target,'http://localhost:3000/api/bots/service/context');
  assert.throws(()=>new ShopBackendClient('http://untrusted.example','KEY',sessions));
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try { assert.throws(()=>new ShopBackendClient('http://localhost:3000','KEY',sessions)); }
  finally { if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous; }
});
test('polling shares deduplication and persists an offset across restarts', async () => {
  const f = fixture(); const connection={...f.connection,updateMode:'polling'};await f.connections.save(connection);
  const offsets=[]; let handled=0;
  f.provider.getUpdates=async (_token,offset)=>{offsets.push(offset);return offset===0?[{update_id:1},{update_id:2,unsupported:true}]:[];};
  f.provider.parseUpdate=value=>value.unsupported?null:{updateId:String(value.update_id),userId:'123',chatId:'123',messageId:value.update_id,text:'/start'};
  const processor=new UpdateProcessor(f.store,f.providers,{handle:async()=>{handled++;}});
  let stop=startPolling(f.store,f.connections,f.providers,processor);
  try { await flush(()=>f.store.data.get(`polling-offset:${connection.id}`)==='3'); }
  finally { stop(); }
  assert.equal(handled,1);
  stop=startPolling(f.store,f.connections,f.providers,processor);
  try { await flush(()=>offsets.length===2); } finally {stop();}
  assert.deepEqual(offsets,[0,3]);assert.equal(handled,1);
});
