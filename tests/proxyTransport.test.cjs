const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { createProviderTransport } = require('../dist/providers/transport');
const { createProviders } = require('../dist/providers/registry');
const { CryptoBox } = require('../dist/storage/cryptoBox');
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('explicit HTTP proxy uses CONNECT and closes its transport cleanly', async () => {
  const origin = http.createServer((_req,res)=>res.end('via-proxy'));
  const originPort = await listen(origin); let connected = 0; const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (_req,socket,head)=>{
    connected++; sockets.add(socket);
    const upstream = net.connect(originPort,'127.0.0.1',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      upstream.pipe(socket);socket.pipe(upstream);
    });
    sockets.add(upstream); upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const transport = createProviderTransport(`http://127.0.0.1:${proxyPort}`);
  try {
    const response = await transport.request(`http://127.0.0.1:${originPort}`,{signal:AbortSignal.timeout(3000)});
    assert.equal(await response.text(),'via-proxy');assert.equal(connected,1);
  } finally { await transport.close(); for(const socket of sockets)socket.destroy();await close(proxy);await close(origin); }
});
test('provider proxy routing stays separate from other providers and shop API transport', async () => {
  let direct=0;let proxied=0;
  const result=()=>Promise.resolve({ok:true,status:200,json:async()=>({ok:true,result:true})});
  const providers=createProviders(()=>{direct++;return result();},{},{telegram:()=>{proxied++;return result();}});
  await providers.telegram.send('TOKEN','123','hello');await providers.bale.send('TOKEN','123','hello');
  assert.equal(proxied,1);assert.equal(direct,1);
  assert.throws(()=>createProviderTransport('socks5://127.0.0.1:10808'));
});
test('unreadable encrypted storage reports the key problem without exposing stored content',()=>{
  const original=new CryptoBox('ab'.repeat(32));const changed=new CryptoBox('cd'.repeat(32));
  assert.throws(()=>changed.open(original.seal({token:'SECRET'})),error=>error.code==='BOT_STORAGE_DECRYPTION_FAILED'&&!JSON.stringify(error).includes('SECRET'));
});
