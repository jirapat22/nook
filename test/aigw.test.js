// Nook's AI through the shared gateway aigw (28/11/2026): aigw first, and on
// ANY aigw problem the old Groq path runs unchanged.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// A fake aigw on a random local port. `reply` decides each answer.
let reply = () => [200, { result: { ok: true }, provider: 'Groq' }];
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    const [status, json] = reply();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

let groq;
test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.AIGW_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AIGW_KEY = 'test-key';
  groq = require('../lib/groq');       // reads AIGW_URL when loaded
});
test.after(() => server.close());

test('journal AI goes to aigw first: free only (private), no local step, same answer budget', async () => {
  seen.length = 0;
  reply = () => [200, { result: { mood: 'calm' }, provider: 'Groq' }];
  const out = await groq.groqChat('groq-key', [
    { role: 'system', content: 'You analyse journal entries.' },
    { role: 'user', content: 'Today was fine.' },
  ], { max_tokens: 1000 });
  assert.deepStrictEqual(out, { mood: 'calm' });
  const { url, auth, body } = seen[0];
  assert.strictEqual(url, '/v1/complete');
  assert.strictEqual(auth, 'Bearer test-key');
  assert.strictEqual(body.private, true);
  assert.strictEqual(body.no_local, true);
  assert.ok(!body.accuracy, 'never the paid tier');
  assert.strictEqual(body.system, 'You analyse journal entries.');
  assert.strictEqual(body.prompt, 'Today was fine.');
  assert.strictEqual(body.max_tokens, 1000 + groq.REASONING_HEADROOM);
});

test('aigw failing (502) means "use the normal path", not an error', async () => {
  reply = () => [502, { error: 'all providers failed' }];
  const out = await groq.aigwChat([{ role: 'user', content: 'x' }]);
  assert.strictEqual(out, undefined);
});

test('a multi-turn chat skips aigw entirely', async () => {
  seen.length = 0;
  const out = await groq.aigwChat([
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
  ]);
  assert.strictEqual(out, undefined);
  assert.strictEqual(seen.length, 0);
});

test('aigw unreachable means "use the normal path"', async () => {
  const saved = process.env.AIGW_URL;
  // A fresh copy of the module pointed at a closed port.
  delete require.cache[require.resolve('../lib/groq')];
  process.env.AIGW_URL = 'http://127.0.0.1:9';
  const fresh = require('../lib/groq');
  assert.strictEqual(await fresh.aigwChat([{ role: 'user', content: 'x' }]), undefined);
  process.env.AIGW_URL = saved;
});
