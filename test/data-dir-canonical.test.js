'use strict';
// Issue #155 — one settings folder for Traycer and terminal sessions.
//
// Traycer launches Claude with --plugin-dir=<install cache path>; Claude Code
// names such a plugin <name>@inline, so CLAUDE_PLUGIN_DATA is
// .../plugins/data/view-limits-inline instead of the marketplace install's
// .../plugins/data/view-limits-<marketplace>. lib/config.js maps the -inline
// folder back to the install's own folder, but only when the RUNNING CODE proves
// it is that install (its real path is <X>/plugins/cache/<mkt>/view-limits/<ver>
// with the same <X>).
//
// Everything here runs in a scratch tree. The real ~/.claude/plugins/data folders
// and the real Keychain are never read, written or named; every config uses the
// file vault, and no test stores a credential.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { canonicalDataDir, inlineRewrite, parseGlobalOptions } = require('../lib/config');
const standalone = require('../lib/standalone-import');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-canon-'));
let seq = 0;
const fresh = (label) => { const d = path.join(scratch, `${label}-${seq += 1}`); fs.mkdirSync(d, { recursive: true }); return d; };

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

// ---- a cache-shaped install ------------------------------------------------------
// <X>/plugins/cache/<mkt>/view-limits/<ver> holds a COPY of the plugin code, so
// that __dirname-derived resolution sees what Claude Code's install cache looks
// like. (A symlink to the checkout would realpath back to the checkout.)
const COPIED = ['bin', 'lib', 'native', 'hooks', 'commands', 'skills', 'harness', 'package.json'];
function copyPlugin(to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of COPIED) {
    if (fs.existsSync(path.join(ROOT, name))) fs.cpSync(path.join(ROOT, name), path.join(to, name), { recursive: true });
  }
}
function install(label, { marketplace = 'kha-marketplace', version = '0.1.56' } = {}) {
  const x = fresh(label);
  const code = path.join(x, 'plugins', 'cache', marketplace, 'view-limits', version);
  copyPlugin(code);
  const data = path.join(x, 'plugins', 'data');
  fs.mkdirSync(data, { recursive: true });
  return {
    x,
    code,
    cli: path.join(code, 'bin', 'vl.js'),
    inline: path.join(data, 'view-limits-inline'),
    canon: path.join(data, `view-limits-${marketplace}`),
    home: fresh('home'),
  };
}

const ROUTE = (id, provider) => ({ id, provider, match: { model: provider }, ttlSeconds: 300 });
const doc = (...ids) => ({
  routes: ids.map((id) => ROUTE(id, id.split('-')[0])),
  vault: { backend: 'file' },
  gate: { mode: 'off' },
});
function put(dir, d) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
}
function run(inst, argv, env = {}) {
  const base = { PATH: process.env.PATH, HOME: inst.home };
  return spawnSync(process.execPath, [inst.cli, ...argv], { env: { ...base, ...env }, encoding: 'utf8', timeout: 30000 });
}
const dataDirOf = (r) => JSON.parse(r.stdout).dataDir;

// Every file under dir → sha256 + mtime, minus the mutation lock's own directory
// (the transient lock a copy takes; same exclusion as test/standalone-import).
function snapshot(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const rel = path.relative(base, p);
    if (rel === 'provider-mutations') continue;
    const st = fs.lstatSync(p);
    if (st.isDirectory()) snapshot(p, base, out);
    else out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}@${st.mtimeMs}`;
  }
  return out;
}
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== 'provider-mutations').sort() : []);

// ---- the resolver: canonicalDataDir ---------------------------------------------

console.log('\ncanonicalDataDir — which folder an install uses');

// A <X>/plugins/{cache/<mkt>/view-limits/<ver>,data} tree of empty directories.
function tree(label, { marketplace = 'kha-marketplace', version = '0.1.56' } = {}) {
  const x = fs.realpathSync(fresh(label));
  const root = path.join(x, 'plugins', 'cache', marketplace, 'view-limits', version);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(x, 'plugins', 'data'), { recursive: true });
  return { x, root, data: path.join(x, 'plugins', 'data') };
}

test('marketplace install: the folder Claude exported is already the canonical one (unchanged)', () => {
  const t = tree('mkt');
  const dir = path.join(t.data, 'view-limits-kha-marketplace');
  assert.strictEqual(canonicalDataDir(dir, { pluginRoot: t.root }), dir);
  assert.strictEqual(inlineRewrite(dir, { pluginRoot: t.root }), null);
});

test('the same install loaded through --plugin-dir (cache path): view-limits-inline → view-limits-<marketplace> (rewritten)', () => {
  const t = tree('plugindir');
  const inline = path.join(t.data, 'view-limits-inline');
  assert.strictEqual(canonicalDataDir(inline, { pluginRoot: t.root }), path.join(t.data, 'view-limits-kha-marketplace'));
  const r = inlineRewrite(inline, { pluginRoot: t.root });
  assert.deepStrictEqual([r.canonical, r.inline, r.marketplace], [path.join(t.data, 'view-limits-kha-marketplace'), inline, 'kha-marketplace']);
  assert.strictEqual(fs.existsSync(inline) || fs.existsSync(r.canonical), false, 'resolving creates nothing');
});

test('any version directory works, and the marketplace name is read from the path', () => {
  const t = tree('ver', { marketplace: 'other_mkt-2', version: '1.2.3-beta.1' });
  assert.strictEqual(canonicalDataDir(path.join(t.data, 'view-limits-inline'), { pluginRoot: t.root }), path.join(t.data, 'view-limits-other_mkt-2'));
});

test('a source checkout loaded with --plugin-dir (dev use) keeps its own -inline folder (unchanged)', () => {
  const t = tree('devsrc');
  const checkout = fresh('checkout');
  const inline = path.join(t.data, 'view-limits-inline');
  assert.strictEqual(canonicalDataDir(inline, { pluginRoot: checkout }), inline);
  const named = path.join(fresh('work'), 'view-limits');
  fs.mkdirSync(named, { recursive: true });
  assert.strictEqual(canonicalDataDir(inline, { pluginRoot: named }), inline, 'a checkout that happens to be called view-limits is still not a cache path');
});

test('a cache entry that is a symlink to a source checkout resolves to the checkout (unchanged)', () => {
  const t = tree('symdev');
  const checkout = fresh('checkout');
  fs.rmSync(t.root, { recursive: true });
  fs.symlinkSync(checkout, t.root);
  assert.strictEqual(canonicalDataDir(path.join(t.data, 'view-limits-inline'), { pluginRoot: t.root }), path.join(t.data, 'view-limits-inline'));
});

test('a mismatched <X> — the code is in one .claude, the data folder in another (unchanged)', () => {
  const a = tree('xa');
  const b = tree('xb');
  const inline = path.join(b.data, 'view-limits-inline');
  assert.strictEqual(canonicalDataDir(inline, { pluginRoot: a.root }), inline);
});

test('a marketplace name Claude would sanitize is NOT guessed at (unchanged): dots, spaces, @', () => {
  for (const marketplace of ['kha.marketplace', 'my market', 'a@b']) {
    const t = tree('san', { marketplace });
    const inline = path.join(t.data, 'view-limits-inline');
    assert.strictEqual(canonicalDataDir(inline, { pluginRoot: t.root }), inline, marketplace);
  }
});

test('a symlinked path in front of the cache (a symlinked ~/.claude): the real path is used (rewritten)', () => {
  const t = tree('real');
  const link = path.join(fresh('links'), 'dot-claude');
  fs.symlinkSync(t.x, link);
  const viaLink = path.join(link, 'plugins', 'cache', 'kha-marketplace', 'view-limits', '0.1.56');
  const inlineViaLink = path.join(link, 'plugins', 'data', 'view-limits-inline');
  assert.strictEqual(canonicalDataDir(inlineViaLink, { pluginRoot: viaLink }), path.join(link, 'plugins', 'data', 'view-limits-kha-marketplace'));
  // …and the same code addressed by its real path against the symlinked data folder.
  assert.strictEqual(canonicalDataDir(inlineViaLink, { pluginRoot: t.root }), path.join(link, 'plugins', 'data', 'view-limits-kha-marketplace'));
});

test('anything that does not have the exact shape is unchanged', () => {
  const t = tree('shape');
  const opts = { pluginRoot: t.root };
  const cases = [
    path.join(t.data, 'view-limits-kha-marketplace'),
    path.join(t.data, 'view-limits-inline-2'),
    path.join(t.data, 'other-inline'),
    path.join(t.x, 'plugins', 'view-limits-inline'),
    path.join(t.x, 'data', 'view-limits-inline'),
    path.join(t.x, 'plugins', 'nope', 'view-limits-inline'),
    path.join(t.x, 'plugins', 'data', 'sub', 'view-limits-inline'),
    path.join(fresh('elsewhere'), 'view-limits-inline'),
    path.join(os.homedir(), '.view-limits'),
    '/', '', 'relative/view-limits-inline',
  ];
  for (const dir of cases) assert.strictEqual(canonicalDataDir(dir, opts), dir, JSON.stringify(dir));
  assert.strictEqual(canonicalDataDir(undefined, opts), undefined);
});

test('a code root that cannot be resolved proves nothing (unchanged)', () => {
  const t = tree('gone');
  const inline = path.join(t.data, 'view-limits-inline');
  assert.strictEqual(canonicalDataDir(inline, { pluginRoot: path.join(t.x, 'plugins', 'cache', 'm', 'view-limits', 'missing') }), inline);
  assert.strictEqual(canonicalDataDir(inline, { pluginRoot: t.root, realpath: () => { throw new Error('EIO'); } }), inline);
});

test('the resolver is idempotent: the canonical folder maps to itself', () => {
  const t = tree('idem');
  const once = canonicalDataDir(path.join(t.data, 'view-limits-inline'), { pluginRoot: t.root });
  assert.strictEqual(canonicalDataDir(once, { pluginRoot: t.root }), once);
});

// ---- parseGlobalOptions ----------------------------------------------------------

console.log('\nparseGlobalOptions — the command path (--data-dir) and the hook path');

test('--data-dir with the -inline folder resolves to the canonical one, and names the -inline folder it mapped away', () => {
  const t = tree('pgo');
  const inline = path.join(t.data, 'view-limits-inline');
  const r = parseGlobalOptions(['--data-dir', inline, '--claude-plugin', 'view'], {}, { pluginRoot: t.root });
  assert.deepStrictEqual([r.ok, r.dataDir, r.inlineDir, r.claudePlugin, r.rest], [true, path.join(t.data, 'view-limits-kha-marketplace'), inline, true, ['view']]);
  const eq = parseGlobalOptions([`--data-dir=${inline}`, 'view'], {}, { pluginRoot: t.root });
  assert.strictEqual(eq.dataDir, path.join(t.data, 'view-limits-kha-marketplace'));
});

test('--claude-plugin with no --data-dir takes the hook environment through the same resolver', () => {
  const t = tree('pgoenv');
  const inline = path.join(t.data, 'view-limits-inline');
  const r = parseGlobalOptions(['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: inline }, { pluginRoot: t.root });
  assert.deepStrictEqual([r.dataDir, r.inlineDir], [path.join(t.data, 'view-limits-kha-marketplace'), inline]);
});

test('a folder that is not rewritten reports no -inline folder, and no folder at all stays null', () => {
  const t = tree('pgoplain');
  const kha = path.join(t.data, 'view-limits-kha-marketplace');
  const r = parseGlobalOptions(['--data-dir', kha, 'view'], {}, { pluginRoot: t.root });
  assert.deepStrictEqual([r.dataDir, r.inlineDir], [kha, null]);
  const dev = parseGlobalOptions(['--data-dir', path.join(t.data, 'view-limits-inline'), 'view'], {}, { pluginRoot: fresh('checkout') });
  assert.strictEqual(path.basename(dev.dataDir), 'view-limits-inline');
  assert.strictEqual(dev.inlineDir, null);
  const none = parseGlobalOptions(['view'], {});
  assert.deepStrictEqual([none.ok, none.dataDir, none.inlineDir], [true, null, null]);
});

test('the argument checks still run first: relative, empty and unexpanded values are refused', () => {
  for (const v of ['relative/view-limits-inline', '', '${CLAUDE_PLUGIN_DATA}']) {
    const r = parseGlobalOptions(['--data-dir', v, 'view'], {});
    assert.strictEqual(r.ok, false, JSON.stringify(v));
  }
});

// ---- the CLI, through a cache-shaped install --------------------------------------

console.log('\nthe real CLI — which folder a process reads and writes');

test('marketplace install: CLAUDE_PLUGIN_DATA=<view-limits-kha-marketplace> is used as it is; no -inline folder appears', () => {
  const i = install('cli-mkt');
  put(i.canon, doc('kimi-code-plan'));
  const r = run(i, ['config'], { CLAUDE_PLUGIN_DATA: i.canon });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(dataDirOf(r), i.canon);
  assert.strictEqual(fs.existsSync(i.inline), false);
});

test('the same install through --plugin-dir, hook/gate path (env only, no flag): reads the marketplace folder', () => {
  const i = install('cli-env');
  put(i.canon, doc('kimi-code-plan'));
  put(i.inline, doc('minimax-token-plan'));
  const before = snapshot(i.inline);
  const r = run(i, ['config'], { CLAUDE_PLUGIN_DATA: i.inline });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(dataDirOf(r), i.canon);
  assert.deepStrictEqual(JSON.parse(r.stdout).routes.map((x) => x.id), ['kimi-code-plan']);
  assert.deepStrictEqual(snapshot(i.inline), before, '-inline is untouched');
});

test('dataDir() itself (what the gate and every library caller read) maps the -inline env to the marketplace folder', () => {
  const i = install('cli-lib');
  const ask = (env) => spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(i.code, 'lib', 'config.js'))}).dataDir())`],
    { env: { PATH: process.env.PATH, HOME: i.home, ...env }, encoding: 'utf8' }).stdout;
  assert.strictEqual(ask({ CLAUDE_PLUGIN_DATA: i.inline }), i.canon);
  assert.strictEqual(ask({ CLAUDE_PLUGIN_DATA: i.canon }), i.canon);
  assert.strictEqual(ask({}), path.join(i.home, '.view-limits'));
  // the checkout itself is not a cache path
  const dev = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).dataDir())`],
    { env: { PATH: process.env.PATH, HOME: i.home, CLAUDE_PLUGIN_DATA: i.inline }, encoding: 'utf8' }).stdout;
  assert.strictEqual(dev, i.inline);
});

test('the same install through --plugin-dir, command path (--data-dir <inline>): reads the marketplace folder', () => {
  const i = install('cli-flag');
  put(i.canon, doc('kimi-code-plan'));
  put(i.inline, doc('minimax-token-plan'));
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(dataDirOf(r), i.canon);
  assert.deepStrictEqual(JSON.parse(r.stdout).routes.map((x) => x.id), ['kimi-code-plan']);
});

test('a source checkout via --plugin-dir keeps its own -inline folder (the real checkout, not a cache copy)', () => {
  const x = fresh('cli-dev');
  const inline = path.join(x, 'plugins', 'data', 'view-limits-inline');
  put(inline, doc('kimi-code-plan'));
  const home = fresh('home');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'vl.js'), '--data-dir', inline, 'config'], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(dataDirOf(r), inline);
  assert.strictEqual(fs.existsSync(path.join(x, 'plugins', 'data', 'view-limits-kha-marketplace')), false);
});

test('a marketplace name that needs sanitizing keeps the -inline folder through the CLI too', () => {
  const i = install('cli-san', { marketplace: 'kha.marketplace' });
  put(i.inline, doc('kimi-code-plan'));
  const r = run(i, ['config'], { CLAUDE_PLUGIN_DATA: i.inline });
  assert.strictEqual(dataDirOf(r), i.inline);
});

// The children vl.js spawns (dashboard daemon, serve, refresh workers) inherit
// process.env, so it must carry the canonical folder — and must not be invented
// where there was none.
const PRELOAD = path.join(scratch, 'print-env.cjs');
fs.writeFileSync(PRELOAD, "process.on('exit', () => process.stderr.write('ENV=' + (process.env.CLAUDE_PLUGIN_DATA === undefined ? '<unset>' : process.env.CLAUDE_PLUGIN_DATA) + '\\n'));\n");
const envSeen = (r) => (/ENV=(.*)/.exec(r.stderr) || [])[1];
const runWithPreload = (i, argv, env) => spawnSync(process.execPath, ['-r', PRELOAD, i.cli, ...argv], { env: { PATH: process.env.PATH, HOME: i.home, ...env }, encoding: 'utf8', timeout: 30000 });

test('children inherit the canonical folder: CLAUDE_PLUGIN_DATA is rewritten once at startup', () => {
  const i = install('cli-child');
  put(i.canon, doc('kimi-code-plan'));
  assert.strictEqual(envSeen(runWithPreload(i, ['config'], { CLAUDE_PLUGIN_DATA: i.inline })), i.canon);
  assert.strictEqual(envSeen(runWithPreload(i, ['--data-dir', i.inline, 'config'], {})), i.canon);
});

test('no CLAUDE_PLUGIN_DATA is invented for the standalone / Codex path', () => {
  const i = install('cli-none');
  put(path.join(i.home, '.view-limits'), doc('kimi-code-plan'));
  const r = runWithPreload(i, ['config'], {});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(envSeen(r), '<unset>');
  assert.strictEqual(dataDirOf(r), path.join(i.home, '.view-limits'));
});

// ---- the import: -inline first, then ~/.view-limits -------------------------------

console.log('\nfirst-run import — the -inline folder is a source, and is never written');

const INLINE_COPIED = 'copied your existing settings from the Traycer data folder (view-limits-inline) into the plugin data folder.';

test('canonical empty, -inline has settings: copied once (config, master key, ciphertexts); -inline bytes and mtimes unchanged', () => {
  const i = install('imp-copy');
  put(i.inline, doc('kimi-code-plan', 'minimax-token-plan'));
  fs.writeFileSync(path.join(i.inline, 'master.key'), 'master-key-bytes', { mode: 0o600 });
  fs.mkdirSync(path.join(i.inline, 'secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(i.inline, 'secrets', 'kimi-code-plan.enc'), '{"ct":"kimi"}', { mode: 0o600 });
  const before = snapshot(i.inline);
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(INLINE_COPIED), r.stderr);
  assert.strictEqual(dataDirOf(r), i.canon);
  assert.deepStrictEqual(names(i.canon), ['config.json', 'master.key', 'secrets']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(i.canon, 'config.json'), 'utf8')), doc('kimi-code-plan', 'minimax-token-plan'));
  assert.strictEqual(fs.readFileSync(path.join(i.canon, 'secrets', 'kimi-code-plan.enc'), 'utf8'), '{"ct":"kimi"}');
  assert.deepStrictEqual(snapshot(i.inline), before, '-inline is byte- and mtime-identical');
  // Once: the next run finds the document and copies nothing.
  const again = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.ok(!again.stderr.includes('copied your existing'), again.stderr);
  assert.deepStrictEqual(snapshot(i.inline), before);
});

test('the hook path (CLAUDE_PLUGIN_DATA=<inline>, --claude-plugin) imports from -inline too', () => {
  const i = install('imp-hook');
  put(i.inline, doc('kimi-code-plan'));
  const r = run(i, ['--claude-plugin', 'config'], { CLAUDE_PLUGIN_DATA: i.inline });
  assert.ok(r.stderr.includes(INLINE_COPIED), r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(i.canon, 'config.json'), 'utf8')).routes.map((x) => x.id), ['kimi-code-plan']);
});

test('canonical already has a config.json: nothing is imported, and BOTH folders stay byte- and mtime-identical (canonical wins)', () => {
  const i = install('imp-both');
  put(i.canon, doc('kimi-code-plan'));
  put(i.inline, doc('minimax-token-plan'));
  const a = snapshot(i.canon);
  const b = snapshot(i.inline);
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes('copied your existing'), r.stderr);
  assert.deepStrictEqual(snapshot(i.canon), a);
  assert.deepStrictEqual(snapshot(i.inline), b);
});

test('canonical empty, -inline has no config.json: the next source (~/.view-limits) is imported', () => {
  const i = install('imp-next');
  fs.mkdirSync(i.inline, { recursive: true });
  put(path.join(i.home, '.view-limits'), doc('kimi-code-plan'));
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.ok(r.stderr.includes('copied your existing settings from the standalone data folder'), r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(i.canon, 'config.json'), 'utf8')).routes.map((x) => x.id), ['kimi-code-plan']);
});

test('both -inline and ~/.view-limits hold settings: -inline wins; ~/.view-limits is not read into the canonical folder', () => {
  const i = install('imp-order');
  put(i.inline, doc('kimi-code-plan'));
  put(path.join(i.home, '.view-limits'), doc('minimax-token-plan'));
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.ok(r.stderr.includes(INLINE_COPIED), r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(i.canon, 'config.json'), 'utf8')).routes.map((x) => x.id), ['kimi-code-plan']);
});

test('HOLD: an unreadable -inline config holds the import (never skips to ~/.view-limits, never proceeds empty), writes nothing, and names the Traycer folder', () => {
  const i = install('imp-hold');
  fs.mkdirSync(i.inline, { recursive: true });
  fs.writeFileSync(path.join(i.inline, 'config.json'), '{not json', { mode: 0o600 });
  put(path.join(i.home, '.view-limits'), doc('minimax-token-plan'));
  const before = snapshot(i.inline);
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.ok(r.stderr.includes('could not copy your existing settings from the Traycer data folder (view-limits-inline)'), r.stderr);
  assert.ok(r.stderr.includes('Fix the Traycer folder or move it aside'), r.stderr);
  assert.ok(r.stderr.includes('(reason: source-config-unreadable)'), r.stderr);
  assert.ok(!r.stderr.includes('standalone'), 'the notice does not blame ~/.view-limits');
  assert.deepStrictEqual(names(i.canon), [], 'nothing is published over an owed import');
  assert.deepStrictEqual(snapshot(i.inline), before);
});

test('HOLD: a -inline config.json that is a symlink is refused as unsafe, naming the Traycer folder', () => {
  const i = install('imp-hold-link');
  fs.mkdirSync(i.inline, { recursive: true });
  const elsewhere = path.join(fresh('x'), 'config.json');
  fs.writeFileSync(elsewhere, JSON.stringify(doc('kimi-code-plan')));
  fs.symlinkSync(elsewhere, path.join(i.inline, 'config.json'));
  const r = run(i, ['--data-dir', i.inline, '--claude-plugin', 'config']);
  assert.ok(r.stderr.includes('Traycer data folder (view-limits-inline)'), r.stderr);
  assert.ok(r.stderr.includes('(reason: unsafe-source)'), r.stderr);
  assert.deepStrictEqual(names(i.canon), []);
});

test('noticeFor names the folder: standalone text is unchanged, inline text names the Traycer folder', () => {
  assert.strictEqual(standalone.noticeFor('refused', 'unsafe-source'), `${standalone.NOTICE_TEXT.refused} (reason: unsafe-source)`);
  assert.strictEqual(standalone.noticeFor('failed', 'copy-failed', 'inline'),
    'could not copy your existing settings from the Traycer data folder (view-limits-inline) into the plugin data folder — nothing was copied; this retries on the next command. (reason: copy-failed)');
});

// ---- the one-time notice (owner question Q51, pending) -----------------------------

console.log('\nthe one-time notice — Traycer settings the install no longer uses');

const messageOf = (r) => { try { return JSON.parse(r.stdout).systemMessage || ''; } catch { return ''; } };
const NOTICE_LINE = (ids) => `view-limits: Traycer sessions had view-limits settings in view-limits-inline that this install no longer uses: ${ids}. Run /view-limits:setup to add them.`;

test('shown once: both folders set up, -inline has a route the install lacks → one line, then never again', () => {
  const i = install('note');
  put(i.canon, doc('kimi-code-plan'));
  put(i.inline, doc('kimi-code-plan', 'minimax-token-plan', 'glm-coding-plan'));
  const before = snapshot(i.inline);
  const first = run(i, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: i.inline });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(messageOf(first), NOTICE_LINE('glm-coding-plan, minimax-token-plan'));
  const record = JSON.parse(fs.readFileSync(path.join(i.canon, 'inline-notice.json'), 'utf8'));
  assert.deepStrictEqual([record.version, record.folder, record.routeIds], [1, 'view-limits-inline', ['glm-coding-plan', 'minimax-token-plan']]);
  assert.strictEqual(fs.statSync(path.join(i.canon, 'inline-notice.json')).mode & 0o777, 0o600);
  for (let n = 0; n < 2; n += 1) {
    const again = run(i, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: i.inline });
    assert.ok(!messageOf(again).includes('no longer uses'), messageOf(again));
  }
  assert.deepStrictEqual(snapshot(i.inline), before, 'the record is written to the install folder; -inline is only read');
  assert.strictEqual(fs.existsSync(path.join(i.inline, 'inline-notice.json')), false);
});

test('not shown when -inline has nothing the install lacks, when there is no -inline config, or when -inline was not mapped away', () => {
  const same = install('note-same');
  put(same.canon, doc('kimi-code-plan', 'minimax-token-plan'));
  put(same.inline, doc('kimi-code-plan'));
  assert.ok(!messageOf(run(same, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: same.inline })).includes('no longer uses'));
  assert.strictEqual(fs.existsSync(path.join(same.canon, 'inline-notice.json')), false, 'nothing recorded when nothing was shown');

  const none = install('note-none');
  put(none.canon, doc('kimi-code-plan'));
  fs.mkdirSync(none.inline, { recursive: true });
  assert.ok(!messageOf(run(none, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: none.inline })).includes('no longer uses'));

  const terminal = install('note-term');
  put(terminal.canon, doc('kimi-code-plan'));
  put(terminal.inline, doc('minimax-token-plan'));
  assert.ok(!messageOf(run(terminal, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: terminal.canon })).includes('no longer uses'), 'a terminal session was never on the -inline folder');
});

test('not shown over an import that is still owed (the install folder has no settings yet)', () => {
  const i = install('note-owed');
  fs.mkdirSync(i.inline, { recursive: true });
  fs.writeFileSync(path.join(i.inline, 'config.json'), '{not json');
  const r = run(i, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: i.inline });
  assert.ok(messageOf(r).includes('Traycer data folder (view-limits-inline)'), messageOf(r));
  assert.ok(!messageOf(r).includes('no longer uses'));
});

test('the off switch: INLINE_NOTICE_ENABLED = false shows nothing and records nothing', () => {
  assert.strictEqual(standalone.INLINE_NOTICE_ENABLED, true, 'on by default, pending the owner');
  const i = install('note-off');
  const lib = path.join(i.code, 'lib', 'standalone-import.js');
  const text = fs.readFileSync(lib, 'utf8');
  assert.ok(text.includes('const INLINE_NOTICE_ENABLED = true;'));
  fs.writeFileSync(lib, text.replace('const INLINE_NOTICE_ENABLED = true;', 'const INLINE_NOTICE_ENABLED = false;'));
  put(i.canon, doc('kimi-code-plan'));
  put(i.inline, doc('kimi-code-plan', 'minimax-token-plan'));
  const r = run(i, ['--claude-plugin', 'session-start'], { CLAUDE_PLUGIN_DATA: i.inline });
  assert.ok(!messageOf(r).includes('no longer uses'), messageOf(r));
  assert.strictEqual(fs.existsSync(path.join(i.canon, 'inline-notice.json')), false);
});

test('the wording lives in one constant (Q51) and route ids that are not plain ids never reach the line', () => {
  assert.strictEqual(standalone.INLINE_NOTICE_TEXT('view-limits-inline', ['a', 'b']),
    'Traycer sessions had view-limits settings in view-limits-inline that this install no longer uses: a, b. Run /view-limits:setup to add them.');
  const target = fresh('target');
  put(target, doc('kimi-code-plan'));
  const inlineDir = fresh('inline');
  fs.writeFileSync(path.join(inlineDir, 'config.json'), JSON.stringify({ routes: [{ id: 'ok-one' }, { id: 'bad id\nwith newline' }, { id: 7 }, null] }));
  const line = standalone.inlineNotice({ target, inlineDir, canonicalRouteIds: ['kimi-code-plan'] });
  assert.ok(line.includes(': ok-one.'), line);
  assert.ok(!/newline/.test(line));
});

// ---- the code that is shipped -------------------------------------------------------

console.log('\nthe cache copy under test');

test('the install copy is a real directory tree, not a symlink to the checkout (so __dirname proves the cache shape)', () => {
  const i = install('shape');
  assert.strictEqual(fs.lstatSync(i.code).isSymbolicLink(), false);
  assert.strictEqual(fs.realpathSync(i.cli), path.join(fs.realpathSync(i.x), 'plugins', 'cache', 'kha-marketplace', 'view-limits', '0.1.56', 'bin', 'vl.js'));
});

fs.rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} data-dir-canonical test(s) failed`);
  process.exit(1);
}
console.log('\ndata-dir-canonical: ok');
