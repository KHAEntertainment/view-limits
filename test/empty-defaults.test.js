'use strict';
// Issue #58 (owner scope addition): config.json is ASSEMBLED by setup and
// PRUNED by remove. A fresh install shows no provider rows; the five shipped
// built-ins are offered for setup but are not present until added; and an
// install that predates this gets a one-time migration that materializes rows
// only for providers whose credentials are actually stored.
//
// Two layers:
//
//   * the migration contract itself, called directly with an injected
//     credential check — the trigger is narrow and the write is all-or-nothing
//   * the real CLI end to end, with the credential CHECK stubbed by
//     test/fixtures/migration-preload.cjs. The migration runs before
//     config.json exists, so the backend it would otherwise see is the macOS
//     Keychain; these tests must never read the developer's real Keychain.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DEFAULTS, BUILT_IN_ROUTES, builtInRoute, migrateRoutesFromVault, loadConfig, configPath,
} = require('../lib/config');

const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/migration-preload.cjs');
const MASTER = 'vl-58-empty-defaults-master';
const KEY_A = 'sk-TEST-empty-defaults-aaaa1111';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`); }
}
function section(name) { console.log(`\n${name}`); }

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-empty-defaults-'));
}

// Run the migration against an injected data dir. CLAUDE_PLUGIN_DATA is what
// dataDir() reads, so this redirects every path the migration touches.
function withDataDir(dir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function present(...ids) {
  const asked = [];
  const check = (id) => { asked.push(id); return ids.includes(id); };
  check.asked = asked;
  return check;
}

function run(dir, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      CLAUDE_PLUGIN_DATA: dir,
      VIEW_LIMITS_MASTER_KEY: MASTER,
      NODE_OPTIONS: `--require=${preload}`,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not every command prints JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function routeIds(dir) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return (Array.isArray(doc.routes) ? doc.routes : []).map((r) => r && r.id);
}

// A config.json that exists, so the migration never fires, with the file vault
// so credentials can actually be stored.
function seeded(routes = []) {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes, vault: { backend: 'file' }, gate: { mode: 'off' },
  }, null, 1));
  return dir;
}

section('empty defaults');

test('DEFAULTS ships no routes, and the catalog holds the five built-ins', () => {
  assert.deepStrictEqual(DEFAULTS.routes, [],
    'a fresh install must show no provider rows');
  assert.deepStrictEqual(BUILT_IN_ROUTES.map((r) => r.id), [
    'minimax-token-plan', 'kimi-code-plan', 'glm-coding-plan', 'deepseek-direct', 'openrouter-main',
  ], 'the offered built-ins are part of the contract — this list is what setup can add');
});

test('a fresh install loads zero routes', () => {
  const dir = scratch();
  withDataDir(dir, () => {
    assert.deepStrictEqual(loadConfig().routes, []);
    assert.strictEqual(fs.existsSync(configPath()), false, 'merely reading config must write nothing');
  });
});

test('builtInRoute hands out copies, never the catalog itself', () => {
  const a = builtInRoute('kimi-code-plan');
  a.ttlSeconds = 99999;
  a.match.model = 'mutated';
  const b = builtInRoute('kimi-code-plan');
  assert.strictEqual(b.ttlSeconds, 180, 'the catalog was mutated through a handed-out route');
  assert.strictEqual(b.match.model, 'kimi', 'a nested field of the catalog was mutated');
  assert.strictEqual(builtInRoute('custom-acme-plan'), null, 'only shipped ids are in the catalog');
  assert.strictEqual(builtInRoute(undefined), null);
});

section('one-time migration — trigger is ABSENCE, nothing else');

test('absent config + stored credentials → rows only for those providers', () => {
  const dir = scratch();
  withDataDir(dir, () => {
    const check = present('kimi-code-plan', 'openrouter-main');
    const r = migrateRoutesFromVault({ hasCredential: check });
    assert.strictEqual(r.migrated, true);
    assert.deepStrictEqual(r.ids, ['kimi-code-plan', 'openrouter-main']);
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'openrouter-main'],
      'a provider with no credential must not get a row');
    // Every built-in is considered exactly once.
    assert.deepStrictEqual(check.asked, BUILT_IN_ROUTES.map((r2) => r2.id));
  });
});

test('the migrated rows are the catalog rows, in full', () => {
  const dir = scratch();
  withDataDir(dir, () => {
    migrateRoutesFromVault({ hasCredential: present('deepseek-direct') });
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepStrictEqual(doc.routes, [builtInRoute('deepseek-direct')],
      'a migrated row must carry the shipped definition, not a stub');
  });
});

test('absent config + NO credentials → zero rows, and it does not run again', () => {
  const dir = scratch();
  withDataDir(dir, () => {
    const first = migrateRoutesFromVault({ hasCredential: present() });
    assert.strictEqual(first.migrated, true);
    assert.deepStrictEqual(first.ids, []);
    assert.deepStrictEqual(routeIds(dir), []);
    // The document it wrote is what makes the trigger false: an install with no
    // credentials must not re-probe the vault on every command (five Keychain
    // subprocesses per invocation, on the CLI's hot path).
    const again = present();
    const second = migrateRoutesFromVault({ hasCredential: again });
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.reason, 'config-present');
    assert.deepStrictEqual(again.asked, [], 'the vault was probed again after migration');
  });
});

test('a config with routes: [] is a CHOICE and is never resurrected', () => {
  const dir = scratch();
  const file = path.join(dir, 'config.json');
  const before = JSON.stringify({ routes: [], vault: { backend: 'file' } }, null, 1);
  fs.writeFileSync(file, before);
  withDataDir(dir, () => {
    const check = present('kimi-code-plan', 'glm-coding-plan');
    const r = migrateRoutesFromVault({ hasCredential: check });
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'config-present');
    assert.deepStrictEqual(check.asked, [], 'a present config must not even be compared to the vault');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before,
      'a user who emptied their routes had them restored from an old vault');
  });
});

test('an empty-object config is present too, so nothing is migrated', () => {
  const dir = scratch();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  withDataDir(dir, () => {
    const r = migrateRoutesFromVault({ hasCredential: present('kimi-code-plan') });
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}');
  });
});

test('an UNPARSEABLE config is present, so it is left exactly as it is', () => {
  // The lifecycle refuses to rewrite a config it cannot read; the migration
  // never even gets that far, because the file existing is already a no.
  const dir = scratch();
  const file = path.join(dir, 'config.json');
  const broken = '{ "routes": [ { "id": "mine", } ] }';
  fs.writeFileSync(file, broken);
  withDataDir(dir, () => {
    const r = migrateRoutesFromVault({ hasCredential: present('kimi-code-plan') });
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), broken,
      'a config we could not parse must never be overwritten');
  });
});

test('a migration that cannot be written lands nothing at all', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('    (skipped: running as root, where mode bits do not deny)');
    return;
  }
  const dir = scratch();
  fs.chmodSync(dir, 0o500);
  try {
    withDataDir(dir, () => {
      const r = migrateRoutesFromVault({ hasCredential: present('kimi-code-plan') });
      assert.strictEqual(r.migrated, false);
      assert.strictEqual(r.reason, 'write-failed');
    });
    assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false,
      'saveConfig is atomic: a failed migration must leave no partial document');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('without a credential check the migration refuses to guess', () => {
  const dir = scratch();
  withDataDir(dir, () => {
    assert.strictEqual(migrateRoutesFromVault({}).reason, 'no-credential-check');
    assert.strictEqual(migrateRoutesFromVault().reason, 'no-credential-check');
    assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false);
  });
});

section('real CLI — assembled by setup, pruned by remove');

test('a fresh install with credentials migrates on first use; others get no row', () => {
  const dir = scratch();
  const r = run(dir, ['provider', 'list', '--json'], { VL_FAKE_PRESENT: 'kimi-code-plan' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
  assert.deepStrictEqual(r.json.routes.map((x) => x.id), ['kimi-code-plan'],
    'exactly the credentialed provider is listed');
  assert.match(r.stderr, /migrated existing credentials into routes: kimi-code-plan/);
});

test('`gate` never migrates: a cache-only read writes nothing and fails open', () => {
  // The gate is the hot path and is cache-only by contract. With zero routes
  // resolveRoute returns null, which is an allow — fail-open, exit 0.
  const dir = scratch();
  const before = fs.readdirSync(dir).sort();
  const r = run(dir, ['gate'], { VL_FAKE_PRESENT: 'kimi-code-plan,openrouter-main' });
  assert.strictEqual(r.status, 0, `gate must fail open with no routes; stderr=${r.stderr}`);
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false,
    'gate migrated, breaking its own no-side-effects contract');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before,
    'gate created or modified a file under the data dir');
});

test('setup assembles the row for a built-in that is not configured yet', () => {
  const dir = seeded([]);
  assert.deepStrictEqual(routeIds(dir), [], 'premise: no rows before setup');
  const r = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'],
    'storing a built-in credential must put its row in config.json');
  assert.strictEqual(fs.existsSync(path.join(dir, 'secrets', 'kimi-code-plan.enc')), true);
  const list = run(dir, ['provider', 'list', '--json']);
  assert.deepStrictEqual(list.json.routes.map((x) => x.id), ['kimi-code-plan']);
});

test('setting the same built-in up twice does not duplicate its row', () => {
  const dir = seeded([]);
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

test('setup offers the built-ins by name on a fresh config; an unknown id still fails', () => {
  const dir = seeded([]);
  const unknown = run(dir, ['setup', 'not-a-route', '--key', KEY_A]);
  assert.strictEqual(unknown.status, 1);
  assert.match(unknown.stderr, /unknown route "not-a-route"/);
  for (const r of BUILT_IN_ROUTES) {
    assert.ok(unknown.stderr.includes(r.id), `${r.id} must be offered as settable`);
  }
});

test('update rotates only what exists: an unconfigured built-in is unknown there', () => {
  // setup CREATES rows, so a built-in is known to it before it exists. update
  // ROTATES an existing credential, so the honest known-list is the configured
  // one — offering a route nobody set up would promise a rotation it cannot do.
  const dir = seeded([]);
  const r = run(dir, ['update', 'kimi-code-plan']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route "kimi-code-plan"/);
});

test('zero rows → add one → exactly one row → remove → zero rows again', () => {
  const dir = seeded([]);
  assert.deepStrictEqual(routeIds(dir), []);
  const add = run(dir, ['provider', 'add', '--label', 'acme-plan', '--recipe', 'anthropic-compat',
    '--endpoint', 'https://acme.example.com', '--option', 'path=/v1/me', '--option', 'scope=account',
    '--key', KEY_A, '--keep-unmonitored', '--json']);
  assert.strictEqual(add.status, 0, add.stderr);
  assert.deepStrictEqual(routeIds(dir), ['custom-acme-plan'], 'setup must assemble exactly one row');
  const remove = run(dir, ['provider', 'remove', 'custom-acme-plan', '--json']);
  assert.strictEqual(remove.status, 0, remove.stderr);
  assert.deepStrictEqual(routeIds(dir), [], 'remove must prune the row it owns');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'secrets')), [],
    'and take the credential with it');
});

test('`vl.js remove` on a shipped built-in keeps its row — credential and cache only', () => {
  // Deliberate asymmetry, and the one place "pruned by remove" does not apply.
  // The lifecycle owns a row only when it is a non-built-in recipe AND a
  // non-shipped id, so a built-in keeps its configured route while losing its
  // credential and cache row. That is the pre-existing behaviour; it is now
  // visible rather than hidden behind a row that was always defaulted in.
  //
  // NOTE: this pins the legacy `remove` verb, which deletes no config row at
  // all. The SHIPPED_ROUTE_IDS protection itself — the catalog wiring that
  // stops `provider remove` deleting a shipped id that carries a monitor — is
  // pinned in test/provider-lifecycle.test.js ("a shipped id is protected even
  // carrying a real custom recipe"), which fails if that set is derived from
  // the now-empty DEFAULTS.routes instead of the catalog.
  const dir = seeded([]);
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
  const r = run(dir, ['remove', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'],
    'a shipped id must not be deletable by remove');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'secrets')), [],
    'but its credential must be gone');
});

test('provider remove on a built-in that was never added is idempotent not-found', () => {
  const dir = seeded([]);
  const r = run(dir, ['provider', 'remove', 'kimi-code-plan', '--json']);
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.json.status, 'not-found');
  assert.deepStrictEqual(routeIds(dir), []);
});

if (failures) {
  console.error(`\n${failures} empty-defaults test(s) failed`);
  process.exit(1);
}
console.log('\nall empty-defaults tests passed');
