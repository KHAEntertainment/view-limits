'use strict';
// Credential setup/rotation integration coverage. Every case uses a scratch
// encrypted-file vault and fake credentials; no Keychain or provider is used.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn, spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../bin/vl.js');
const PRELOAD = path.resolve(__dirname, 'fixtures/credential-failure-preload.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-credentials-'));
const MASTER_KEY = 'fake-offline-master-key';
const OLD = 'OLD_SECRET_SENTINEL';
const NATIVE = 'NATIVE_SECRET_SENTINEL';
const REPLACEMENT = 'REPLACEMENT_SECRET_SENTINEL';
const HEADLESS = 'HEADLESS_SECRET_SENTINEL';
const THROW_SENTINEL = 'THROWN_SECRET_SENTINEL';
const SECRET_SENTINELS = [OLD, NATIVE, REPLACEMENT, HEADLESS, THROW_SENTINEL];

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failures += 1; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
}

function scratch(name, routes, extra = {}) {
  const dir = path.join(ROOT, name);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes,
    providers: {},
    vault: { backend: 'file', service: 'test-only' },
    importMap: {},
    ...extra,
  }));
  return { dir, home };
}

function envFor(ctx, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: ctx.home,
    CLAUDE_PLUGIN_DATA: ctx.dir,
    VIEW_LIMITS_MASTER_KEY: MASTER_KEY,
    ...extra,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

function run(ctx, args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: envFor(ctx, options.env), encoding: 'utf8', input: options.input, timeout: 5000,
  });
}

function withVault(ctx, fn) {
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = ctx.dir;
  process.env.VIEW_LIMITS_MASTER_KEY = MASTER_KEY;
  try { return fn(require('../lib/vault')); }
  finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
    if (previousKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY;
    else process.env.VIEW_LIMITS_MASTER_KEY = previousKey;
  }
}

function assertSecretsHidden(value) {
  const text = String(value || '');
  for (const sentinel of SECRET_SENTINELS) assert.ok(!text.includes(sentinel), `secret leaked: ${sentinel}`);
}

function assertResultSecretsHidden(result) {
  assertSecretsHidden(result.stdout);
  assertSecretsHidden(result.stderr);
}

function writeNative(home, relative, secret) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ api_key: secret }));
  return file;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function canUseLoopback() {
  try {
    await freePort();
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return false;
    throw error;
  }
}

function request(port, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: '/',
      headers: body == null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.once('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await request(port); }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error('credential server did not start');
}

function startServer(ctx, port, nonce, routes, extraEnv = {}) {
  const ids = Array.isArray(routes) ? routes : [routes];
  const child = spawn(process.execPath, [CLI, 'serve', String(port), nonce, ...ids], {
    env: envFor(ctx, extraEnv), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, output: () => stdout + stderr };
}

const route = (id) => ({ id, provider: 'fake', account: 'test', match: { model: id } });

(async () => {
  console.log('credential rotation — setup, direct, headless and form safety');
  const loopbackAvailable = await canUseLoopback();

  await test('setup keeps native auto-import while update direct and headless skip it', async () => {
    const ctx = scratch('rotation', [route('minimax-token-plan')], {
      importMap: { 'minimax-token-plan': { file: '~/.mmx/config.json', field: 'api_key' } },
    });
    writeNative(ctx.home, '.mmx/config.json', NATIVE);

    const setup = run(ctx, ['setup', 'minimax-token-plan']);
    assert.strictEqual(setup.status, 0, setup.stderr);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('minimax-token-plan')), NATIVE);
    assert.match(setup.stderr, /imported from native config: minimax-token-plan/);
    assertResultSecretsHidden(setup);

    const direct = run(ctx, ['update', 'minimax-token-plan', '--key', REPLACEMENT]);
    assert.strictEqual(direct.status, 0, direct.stderr);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('minimax-token-plan')), REPLACEMENT);
    assert.match(direct.stderr, /stored credential for "minimax-token-plan"/);
    assertResultSecretsHidden(direct);

    const headless = run(ctx, ['update', 'minimax-token-plan', '--headless'], { input: `${HEADLESS}\n` });
    assert.strictEqual(headless.status, 0, headless.stderr);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('minimax-token-plan')), HEADLESS);
    assert.match(headless.stderr, /stored credentials for: minimax-token-plan/);
    assertResultSecretsHidden(headless);
  });

  await test('invalid route and explicit-key arguments fail before a vault write', async () => {
    const ctx = scratch('arguments', [route('known-route')]);
    const unknown = run(ctx, ['update', 'missing-route', '--key', REPLACEMENT]);
    assert.strictEqual(unknown.status, 1);
    assert.match(unknown.stderr, /unknown route/);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'secrets')));
    assertResultSecretsHidden(unknown);

    const missing = run(ctx, ['update', 'known-route', '--key']);
    assert.strictEqual(missing.status, 1);
    assert.match(missing.stderr, /--key requires a non-empty value/);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'secrets')));

    withVault(ctx, (vault) => vault.set('known-route', OLD));
    const whitespace = run(ctx, ['update', 'known-route', '--key', '   ']);
    assert.strictEqual(whitespace.status, 1);
    assert.match(whitespace.stderr, /--key requires a non-empty value/);
    assertResultSecretsHidden(whitespace);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('known-route')), OLD);
  });

  await test('direct and headless write failures are contained and preserve the old credential', async () => {
    const ctx = scratch('cli-failures', [route('known-route')]);
    withVault(ctx, (vault) => vault.set('known-route', OLD));
    const failureEnv = {
      NODE_OPTIONS: `--require=${PRELOAD}`,
      VL_FAIL_VAULT_ROUTE: 'known-route',
      VL_THROW_SENTINEL: THROW_SENTINEL,
    };

    const direct = run(ctx, ['update', 'known-route', '--key', REPLACEMENT], { env: failureEnv });
    assert.strictEqual(direct.status, 1);
    assert.match(direct.stderr, /could not store credential for "known-route"/);
    assertResultSecretsHidden(direct);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('known-route')), OLD);

    const headless = run(ctx, ['update', 'known-route', '--headless'], {
      env: failureEnv, input: `${HEADLESS}\n`,
    });
    assert.strictEqual(headless.status, 1);
    assert.match(headless.stderr, /could not store credentials for: known-route/);
    assert.doesNotMatch(headless.stderr, /done|stored credentials for:/);
    assertResultSecretsHidden(headless);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('known-route')), OLD);
  });

  await test('file-vault master key is required before browser or server startup', async () => {
    const ctx = scratch('preflight', [route('known-route')]);
    const spawnLog = path.join(ctx.dir, 'spawn.log');
    const env = {
      VIEW_LIMITS_MASTER_KEY: undefined,
      NODE_OPTIONS: `--require=${PRELOAD}`,
      VL_SPAWN_LOG: spawnLog,
    };
    const setup = run(ctx, ['setup', 'known-route'], { env });
    assert.strictEqual(setup.status, 1);
    assert.match(setup.stderr, /file vault needs VIEW_LIMITS_MASTER_KEY/);
    assert.doesNotMatch(setup.stderr, /credential form:/);
    assert.ok(!fs.existsSync(spawnLog), 'browser/server spawn must not be attempted');
    assertResultSecretsHidden(setup);

    fs.writeFileSync(path.join(ctx.dir, 'master.key'), '');
    const emptyKey = run(ctx, ['setup', 'known-route'], { env });
    assert.strictEqual(emptyKey.status, 1);
    assert.match(emptyKey.stderr, /file vault needs VIEW_LIMITS_MASTER_KEY/);
    assert.ok(!fs.existsSync(spawnLog), 'an empty master.key must not allow startup');

    const serve = run(ctx, ['serve', '45123', 'nonce', 'known-route'], { env });
    assert.strictEqual(serve.status, 1);
    assert.match(serve.stderr, /file vault needs VIEW_LIMITS_MASTER_KEY/);
  });

  await test('form nonce rejection and successful save preserve no-store and shutdown lifecycle', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; lifecycle exercised when host permits binding)'); return; }
    const ctx = scratch('form-success', [route('known-route')]);
    withVault(ctx, (vault) => vault.set('known-route', OLD));

    const rejectedPort = await freePort();
    const rejected = startServer(ctx, rejectedPort, 'expected-nonce', 'known-route');
    const page = await waitForServer(rejectedPort);
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers['cache-control'], 'no-store');
    assert.match(page.body, /type="password"[^>]*required/);
    const bad = await request(rejectedPort, {
      method: 'POST', body: JSON.stringify({ nonce: 'wrong', credentials: { 'known-route': REPLACEMENT } }),
    });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(bad.headers['cache-control'], 'no-store');
    assertSecretsHidden(bad.body);
    const [badCode] = await once(rejected.child, 'exit');
    assert.strictEqual(badCode, 0, rejected.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('known-route')), OLD);

    const successPort = await freePort();
    const success = startServer(ctx, successPort, 'expected-nonce', 'known-route');
    await waitForServer(successPort);
    const saved = await request(successPort, {
      method: 'POST', body: JSON.stringify({ nonce: 'expected-nonce', credentials: { 'known-route': REPLACEMENT } }),
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.headers['cache-control'], 'no-store');
    assert.match(saved.body, /Routes: known-route/);
    assertSecretsHidden(saved.body);
    const [successCode] = await once(success.child, 'exit');
    assert.strictEqual(successCode, 0, success.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('known-route')), REPLACEMENT);
  });

  await test('form rejects non-object JSON with safe 400 responses and normal shutdown', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; malformed-body lifecycle exercised when host permits binding)'); return; }
    const ctx = scratch('form-malformed', [route('known-route')]);
    withVault(ctx, (vault) => vault.set('known-route', OLD));
    for (const [index, body] of ['null', '[]', '42', '"text"'].entries()) {
      const port = await freePort();
      const server = startServer(ctx, port, `nonce-${index}`, 'known-route');
      await waitForServer(port);
      const response = await request(port, { method: 'POST', body });
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.headers['cache-control'], 'no-store');
      assert.strictEqual(response.body, 'bad request');
      assertSecretsHidden(response.body);
      const [code] = await once(server.child, 'exit');
      assert.strictEqual(code, 0, server.output());
      assert.doesNotMatch(server.output(), /TypeError|uncaught|ECONNRESET/);
      assertSecretsHidden(server.output());
    }
    assert.strictEqual(withVault(ctx, (vault) => vault.get('known-route')), OLD);
  });

  await test('form rejects blank and mixed incomplete replacements without false success', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; incomplete-form lifecycle exercised when host permits binding)'); return; }
    const routes = ['route-one', 'route-two', 'route-three', 'route-four'];
    const ctx = scratch('form-incomplete', routes.map(route));
    withVault(ctx, (vault) => routes.forEach((id) => vault.set(id, OLD)));

    const blankPort = await freePort();
    const blankServer = startServer(ctx, blankPort, 'blank-nonce', 'route-one');
    await waitForServer(blankPort);
    const blank = await request(blankPort, {
      method: 'POST', body: JSON.stringify({ nonce: 'blank-nonce', credentials: { 'route-one': '' } }),
    });
    assert.strictEqual(blank.status, 400);
    assert.strictEqual(blank.headers['cache-control'], 'no-store');
    assert.match(blank.body, /Stored: none/);
    assert.match(blank.body, /Could not store: route-one/);
    assertSecretsHidden(blank.body);
    const [blankCode] = await once(blankServer.child, 'exit');
    assert.strictEqual(blankCode, 1, blankServer.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), OLD);

    const mixedPort = await freePort();
    const mixedServer = startServer(ctx, mixedPort, 'mixed-nonce', routes);
    await waitForServer(mixedPort);
    const mixed = await request(mixedPort, {
      method: 'POST', body: JSON.stringify({
        nonce: 'mixed-nonce',
        credentials: { 'route-one': REPLACEMENT, 'route-two': '   ', 'route-three': 123 },
      }),
    });
    assert.strictEqual(mixed.status, 400);
    assert.strictEqual(mixed.headers['cache-control'], 'no-store');
    assert.match(mixed.body, /Stored: route-one/);
    assert.match(mixed.body, /Could not store: route-two, route-three, route-four/);
    assertSecretsHidden(mixed.body);
    const [mixedCode] = await once(mixedServer.child, 'exit');
    assert.strictEqual(mixedCode, 1, mixedServer.output());
    assertSecretsHidden(mixedServer.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), REPLACEMENT);
    for (const id of ['route-two', 'route-three', 'route-four']) {
      assert.strictEqual(withVault(ctx, (vault) => vault.get(id)), OLD);
    }
  });

  await test('form write failure returns safe HTML and preserves the old credential', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; failure response exercised when host permits binding)'); return; }
    const ctx = scratch('form-failure', [route('route-one'), route('route-two')]);
    withVault(ctx, (vault) => {
      vault.set('route-one', OLD);
      vault.set('route-two', OLD);
    });
    const port = await freePort();
    const server = startServer(ctx, port, 'expected-nonce', ['route-one', 'route-two'], {
      NODE_OPTIONS: `--require=${PRELOAD}`,
      VL_FAIL_VAULT_ROUTE: 'route-two',
      VL_THROW_SENTINEL: THROW_SENTINEL,
    });
    await waitForServer(port);
    const response = await request(port, {
      method: 'POST', body: JSON.stringify({
        nonce: 'expected-nonce',
        credentials: { 'route-one': REPLACEMENT, 'route-two': HEADLESS },
      }),
    });
    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.headers['cache-control'], 'no-store');
    assert.match(response.body, /Stored: route-one/);
    assert.match(response.body, /Could not store: route-two/);
    assertSecretsHidden(response.body);
    const [code] = await once(server.child, 'exit');
    assert.strictEqual(code, 1, server.output());
    assertSecretsHidden(server.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), REPLACEMENT);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-two')), OLD);
  });

  await test('update arguments select exactly the requested route(s) for the form', async () => {
    const ctx = scratch('update-args', [route('route-a'), route('route-b'), route('route-c')]);
    const spawnLog = path.join(ctx.dir, 'spawn.log');
    const env = {
      NODE_OPTIONS: `--require=${PRELOAD}`,
      VL_SPAWN_LOG: spawnLog,
      VL_SPAWN_STUB: '1',
    };
    const serveIds = () => {
      if (!fs.existsSync(spawnLog)) return [];
      return fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((e) => path.basename(e.args[0] || '') === 'vl.js' && e.args[1] === 'serve')
        .map((e) => e.args.slice(4));
    };

    const single = run(ctx, ['update', 'route-b'], { env });
    assert.strictEqual(single.status, 0, single.stderr);
    assert.match(single.stderr, /credential form: http:\/\/127\.0\.0\.1:\d+/);
    assert.deepStrictEqual(serveIds(), [['route-b']]);
    assertResultSecretsHidden(single);

    withVault(ctx, (vault) => {
      vault.set('route-a', OLD);
      vault.set('route-c', OLD);
    });
    fs.rmSync(spawnLog, { force: true });
    const all = run(ctx, ['update'], { env });
    assert.strictEqual(all.status, 0, all.stderr);
    assert.match(all.stderr, /updating credentials for: route-a, route-c/);
    assert.deepStrictEqual(serveIds(), [['route-a', 'route-c']]);
    assertResultSecretsHidden(all);

    const empty = scratch('update-empty', [route('route-a')]);
    const emptyLog = path.join(empty.dir, 'spawn.log');
    const none = run(empty, ['update'], { env: { ...env, VL_SPAWN_LOG: emptyLog } });
    assert.strictEqual(none.status, 0, none.stderr);
    assert.match(none.stderr, /no credentials to update/);
    assert.ok(!fs.existsSync(emptyLog), 'no credential form must be spawned');
  });

  await test('update argument errors fail honestly before any form or vault write', async () => {
    const ctx = scratch('update-arg-errors', [route('route-a'), route('route-b')]);
    const spawnLog = path.join(ctx.dir, 'spawn.log');
    const env = {
      NODE_OPTIONS: `--require=${PRELOAD}`,
      VL_SPAWN_LOG: spawnLog,
      VL_SPAWN_STUB: '1',
    };

    const unknown = run(ctx, ['update', 'route-x'], { env });
    assert.strictEqual(unknown.status, 1);
    assert.match(unknown.stderr, /unknown route "route-x" \(known: route-a, route-b\)/);
    assert.ok(!fs.existsSync(spawnLog), 'an unknown route must not open the all-routes form');
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'secrets')), 'no vault write on failure');
    assertResultSecretsHidden(unknown);

    const multiple = run(ctx, ['update', 'route-a', 'route-b'], { env });
    assert.strictEqual(multiple.status, 1);
    assert.match(multiple.stderr, /only one route can be selected at a time/);
    assert.ok(!fs.existsSync(spawnLog));
    assertResultSecretsHidden(multiple);

    const keyless = run(ctx, ['update', '--key', 'sk-test-unused'], { env });
    assert.strictEqual(keyless.status, 1);
    assert.match(keyless.stderr, /--key requires a route id/);
    assert.ok(!fs.existsSync(spawnLog));
    assertResultSecretsHidden(keyless);
  });

  await test('served form script parses and the page carries rotate semantics and auto-close contract', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; markup exercised when host permits binding)'); return; }
    const ctx = scratch('form-markup', [route('route-one'), route('route-two')]);
    withVault(ctx, (vault) => vault.set('route-one', OLD));

    const port = await freePort();
    const server = startServer(ctx, port, 'nonce-markup', 'route-one');
    const page = await waitForServer(port);
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<input id="route-one" type="password"/);
    assert.ok(!page.body.includes('route-two'), 'form must only contain the requested route');
    assert.match(page.body, /existing keys stay valid until you submit/);
    assert.match(page.body, /opening this form clears nothing/);

    const script = page.body.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script, 'form must embed a submit handler');
    new Function(script[1]);
    assert.match(script[1], /method:'POST'/);
    assert.match(script[1], /nonce/);
    assert.match(script[1], /Closing in <span id="n">5<\/span>/);
    assert.match(script[1], /window\.close\(\)/);

    const saved = await request(port, {
      method: 'POST',
      body: JSON.stringify({ nonce: 'nonce-markup', credentials: { 'route-one': REPLACEMENT } }),
    });
    assert.strictEqual(saved.status, 200);
    assert.match(saved.body, /Closing in <span id="n">5<\/span>/);
    assert.match(saved.body, /window\.close\(\)/);
    assertSecretsHidden(saved.body);
    const [code] = await once(server.child, 'exit');
    assert.strictEqual(code, 0, server.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), REPLACEMENT);
  });

  await test('a second submission after save is refused and never rewrites the vault', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; double-submit lifecycle exercised when host permits binding)'); return; }
    const ctx = scratch('form-double-submit', [route('route-one')]);
    withVault(ctx, (vault) => vault.set('route-one', OLD));

    let sawConflict = false;
    for (let attempt = 0; attempt < 3 && !sawConflict; attempt += 1) {
      const port = await freePort();
      const server = startServer(ctx, port, `nonce-${attempt}`, 'route-one');
      await waitForServer(port);
      const first = await request(port, {
        method: 'POST',
        body: JSON.stringify({ nonce: `nonce-${attempt}`, credentials: { 'route-one': REPLACEMENT } }),
      });
      assert.strictEqual(first.status, 200);
      let second = null;
      try {
        second = await request(port, {
          method: 'POST',
          body: JSON.stringify({ nonce: `nonce-${attempt}`, credentials: { 'route-one': HEADLESS } }),
        });
      } catch (error) {
        assert.ok(error && (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'),
          `second submit failed with an unexpected error: ${error && error.message}`);
      }
      const [code] = await once(server.child, 'exit');
      assert.strictEqual(code, 0, server.output());
      assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), REPLACEMENT);
      if (second) {
        sawConflict = true;
        assert.strictEqual(second.status, 409);
        assert.match(second.body, /already submitted/);
        assertSecretsHidden(second.body);
      }
    }
    assert.ok(sawConflict, 'an in-window double submit must be refused with 409');
  });

  await test('wrong-method and oversized submissions fail safely with zero vault writes', async () => {
    if (!loopbackAvailable) { console.log('    (loopback unavailable; method/size guards exercised when host permits binding)'); return; }
    const ctx = scratch('form-guards', [route('route-one')]);
    withVault(ctx, (vault) => vault.set('route-one', OLD));

    const port = await freePort();
    const server = startServer(ctx, port, 'nonce-methods', 'route-one');
    await waitForServer(port);
    for (const method of ['PUT', 'DELETE']) {
      const response = await request(port, { method, body: '{}' });
      assert.strictEqual(response.status, 405);
      assert.strictEqual(response.headers['cache-control'], 'no-store');
      assertSecretsHidden(response.body);
    }
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), OLD);
    const saved = await request(port, {
      method: 'POST',
      body: JSON.stringify({ nonce: 'nonce-methods', credentials: { 'route-one': REPLACEMENT } }),
    });
    assert.strictEqual(saved.status, 200);
    const [code] = await once(server.child, 'exit');
    assert.strictEqual(code, 0, server.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), REPLACEMENT);

    const bigPort = await freePort();
    const big = startServer(ctx, bigPort, 'nonce-big', 'route-one');
    await waitForServer(bigPort);
    const oversized = await request(bigPort, {
      method: 'POST',
      body: JSON.stringify({ nonce: 'nonce-big', credentials: { 'route-one': 'x'.repeat(80 * 1024) } }),
    });
    assert.strictEqual(oversized.status, 413);
    assertSecretsHidden(oversized.body);
    const [bigCode] = await once(big.child, 'exit');
    assert.strictEqual(bigCode, 0, big.output());
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), REPLACEMENT);
  });

  await test('multi-route setup reports only successful and failed route ids', async () => {
    const ctx = scratch('multi-setup', [route('route-one'), route('route-two')], {
      importMap: {
        'route-one': { file: '~/native-one.json', field: 'api_key' },
        'route-two': { file: '~/native-two.json', field: 'api_key' },
      },
    });
    writeNative(ctx.home, 'native-one.json', NATIVE);
    writeNative(ctx.home, 'native-two.json', REPLACEMENT);
    withVault(ctx, (vault) => vault.set('route-two', OLD));
    const result = run(ctx, ['setup'], { env: {
      NODE_OPTIONS: `--require=${PRELOAD}`,
      VL_FAIL_VAULT_ROUTE: 'route-two',
      VL_THROW_SENTINEL: THROW_SENTINEL,
    } });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /imported from native config: route-one/);
    assert.match(result.stderr, /could not import credentials for: route-two/);
    assertResultSecretsHidden(result);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-one')), NATIVE);
    assert.strictEqual(withVault(ctx, (vault) => vault.get('route-two')), OLD);
  });
})().finally(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} credential test(s) failed`); process.exit(1); }
  console.log('\nall credential rotation tests passed');
});
