'use strict';
// Issue #103 — the view header: the ascii.rest "View-Limits" banner.
//
// What it covers:
//   * the static banner IS the header of the full text layout, byte for byte
//   * a piped or captured view prints it first, with no escape byte and no
//     delay — and does NOT load the dependency
//   * a terminal loads the dependency and draws the live banner
//   * NO_COLOR decides, per no-color.org: present AND non-empty → the static
//     banner and no import; present and empty → as if it were unset
//   * TERM=dumb takes the static banner
//   * a missing dependency falls back to the static banner, silently
//   * --json and --condensed carry no banner and no escape byte
//
// No network and no real credentials: the scratch data dir holds a configured
// route with no credential, so the collector never reaches a provider.
//
// The terminal cases run the CLI under a pty (`script`), so the child's
// stdout really is a TTY. The dependency is a FAKE package in a scratch copy
// of the plugin: importing it writes a marker file, so the test can tell
// that it was loaded — and what it drew.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VL = path.join(ROOT, 'bin', 'vl.js');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

// The static banner: the ascii.rest "View-Limits" banner as plain text —
// 8 lines, no escape bytes. The literal expectation, independent of the
// implementation.
const EXPECTED_BANNER = [
  '▓┓  ▓▓ ▓▓▓┓ ▓▓▓▓▓▓ ▓┓  ▓▓       ▓▓     ▓▓▓┓ ▓▓  ▓▓ ▓▓▓▓ ▓▓▓▓▓▓  ▓▓▓▓',
  '▓┃  ▓┃ ┗▓┏┛ ▓┏━━━┛ ▓┃  ▓┃       ▓┃     ┗▓┏┛ ▓▓▓▓▓┃ ┗▓┏┛ ┗━▓┏━┛ ▓┏━━▓┓',
  '▓┃  ▓┃  ▓┃  ▓┃     ▓┃  ▓┃       ▓┃      ▓┃  ▓┏▓┏▓┃  ▓┃    ▓┃   ▓┃  ┗┛',
  '▓┃  ▓┃  ▓┃  ▓▓▓▓▓  ▓┃▓▓▓┃ ▓▓▓▓▓ ▓┃      ▓┃  ▓┃▓┃▓┃  ▓┃    ▓┃   ┗▓▓▓┓',
  '▓┃  ▓┃  ▓┃  ▓┏━━┛  ▓┃▓┃▓┃ ┗━━━┛ ▓┃      ▓┃  ▓┃┗┛▓┃  ▓┃    ▓┃    ┗━━▓▓',
  '┗▓▓▓┏┛  ▓┃  ▓┃     ▓▓┏▓▓┃       ▓┃      ▓┃  ▓┃  ▓┃  ▓┃    ▓┃   ▓▓  ▓┃',
  ' ┗▓┏┛  ▓▓▓▓ ▓▓▓▓▓▓ ▓┏┛┗▓┃       ▓▓▓▓▓▓ ▓▓▓▓ ▓┃  ▓┃ ▓▓▓▓   ▓┃   ┗▓▓▓┏┛',
  '  ┗┛   ┗━━┛ ┗━━━━┛ ┗┛  ┗┛       ┗━━━━┛ ┗━━┛ ┗┛  ┗┛ ┗━━┛   ┗┛    ┗━━┛',
];

const BANNER_TEXT = EXPECTED_BANNER.join('\n');
const ESC = '\u001b';

const ROUTES = [
  { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 },
];

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-banner-'));
}

// A data dir with one configured route and a fresh cached status. No
// credential is stored, so the collection reports "no credentials" and never
// reaches a provider.
function writeFixture(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: ROUTES,
    gate: { mode: 'off', constrainedThreshold: 0.2 },
    vault: { backend: 'file', service: 'com.kha.view-limits' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    routes: {
      'minimax-token-plan': {
        routeId: 'minimax-token-plan',
        observedAt: '2026-10-13T09:45:00Z',
        freshUntil: '2099-01-01T00:00:00Z',
        source: 'adapter',
        status: {
          state: 'healthy',
          windows: [{ type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2099-01-01T12:00:00Z' }],
        },
      },
    },
  }, null, 2));
}

// A scratch copy of the plugin, optionally with a FAKE ascii.rest package:
// importing it writes the marker file, and drawing it writes the text.
function scratchPlugin({ fake = true } = {}) {
  const root = scratch();
  fs.cpSync(path.join(ROOT, 'bin'), path.join(root, 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  writeFixture(data);
  if (fake) {
    const pkg = path.join(root, 'node_modules', 'ascii.rest');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'ascii.rest',
      version: '0.4.0',
      type: 'module',
      exports: { './terminal': { default: './terminal.js' } },
    }, null, 2));
    fs.writeFileSync(path.join(pkg, 'terminal.js'), [
      "import fs from 'node:fs';",
      "if (process.env.VL_BANNER_MARKER) fs.writeFileSync(process.env.VL_BANNER_MARKER, 'loaded');",
      'export async function banner(text, options) {',
      "  process.stdout.write('\\u001b[38;2;59;232;88m' + text + '\\u001b[0m\\n');",
      '  return { cols: text.length, rows: 1, interrupted: false };',
      '}',
      '',
    ].join('\n'));
  }
  return { root, data, vl: path.join(root, 'bin', 'vl.js') };
}

function runView(vl, data, args = ['view'], env = {}) {
  const r = spawnSync(process.execPath, [vl, ...args], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// A run that BELIEVES it is on a terminal: the preload makes stdout a TTY,
// so the CLI takes the terminal path. The real pty path — `script -q /dev/null
// node bin/vl.js view` — needs a tty on the runner's own stdin, which a
// spawned test does not have; it is verified by hand instead.
function runViewOnTerminal(vl, data, args = ['view'], env = {}) {
  const preload = path.join(path.dirname(data), 'tty-preload.cjs');
  fs.writeFileSync(preload, [
    'process.stdout.isTTY = true;',
    'process.stdout.columns = 100;',
    'process.stdout.rows = 24;',
    '',
  ].join('\n'));
  // The runner's own NODE_OPTIONS (the data-dir guard) is kept.
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ');
  return runView(vl, data, args, { ...env, NODE_OPTIONS: nodeOptions });
}

// ---- the model ---------------------------------------------------------------

test('the full text layout starts with the static banner', () => {
  const { renderViewText } = require('../lib/view-model');
  const lines = renderViewText({ routes: [] });
  assert.deepStrictEqual(lines.slice(0, EXPECTED_BANNER.length), EXPECTED_BANNER,
    'the static banner is the header');
});

test('the caller can replace the header, and can leave it out', () => {
  const { renderViewText } = require('../lib/view-model');
  const replaced = renderViewText({ routes: [] }, { header: ['LIVE BANNER'] });
  assert.strictEqual(replaced[0], 'LIVE BANNER', 'the caller header wins');
  const none = renderViewText({ routes: [] }, { header: [] });
  assert.ok(!none.join('\n').includes('QUOTA REMAINING') === false, 'the body is still there');
  assert.strictEqual(none.length, replaced.length - 1, 'only the header lines are gone');
});

// ---- the CLI ----------------------------------------------------------------

test('a piped view prints the static banner first, with no escape byte', () => {
  const dir = scratch();
  writeFixture(dir);
  const r = runView(VL, dir);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.startsWith(`${BANNER_TEXT}\n`), 'the static banner is first');
  assert.ok(!r.stdout.includes(ESC), 'no escape byte');
  assert.ok(r.stdout.includes('QUOTA REMAINING'), 'the body follows the banner');
});

test('a piped view does not load the dependency', () => {
  const { root, data, vl } = scratchPlugin();
  const marker = path.join(root, 'marker');
  const r = runView(vl, data, ['view'], { VL_BANNER_MARKER: marker });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(!fs.existsSync(marker), 'the dependency was NOT loaded');
  assert.ok(r.stdout.startsWith(`${BANNER_TEXT}\n`), 'the static banner stands in');
});

test('a terminal loads the dependency and draws the live banner', () => {
  const { root, data, vl } = scratchPlugin();
  const marker = path.join(root, 'marker');
  const r = runViewOnTerminal(vl, data, ['view'], { VL_BANNER_MARKER: marker });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(fs.existsSync(marker), 'the dependency WAS loaded');
  assert.ok(r.stdout.includes('View-Limits'), 'the live banner was drawn');
  assert.ok(!r.stdout.includes(EXPECTED_BANNER[0]), 'the static banner did not stand in');
});

test('the real dependency plays one glint pass on a terminal', () => {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'ascii.rest', 'package.json'))) {
    console.log('  – the real dependency is not installed: skipped');
    return;
  }
  const dir = scratch();
  writeFixture(dir);
  const started = Date.now();
  const r = runViewOnTerminal(VL, dir, ['view']);
  const elapsed = Date.now() - started;
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes(ESC), 'the live banner is coloured');
  assert.ok(!r.stdout.includes(EXPECTED_BANNER[0]), 'the static banner did not stand in');
  assert.ok(elapsed >= 400, `the glint pass played (${elapsed}ms)`);
  assert.ok(r.stdout.includes('QUOTA REMAINING'), 'the body follows the banner');
});

test('NO_COLOR set (present and non-empty) takes the static banner and loads nothing', () => {
  const { root, data, vl } = scratchPlugin();
  const marker = path.join(root, 'marker');
  const r = runViewOnTerminal(vl, data, ['view'], { NO_COLOR: '1', VL_BANNER_MARKER: marker });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(!fs.existsSync(marker), 'the dependency was NOT loaded');
  assert.ok(r.stdout.includes(EXPECTED_BANNER[0]), 'the static banner stands in');
});

test('NO_COLOR empty behaves like unset', () => {
  const { root, data, vl } = scratchPlugin();
  const marker = path.join(root, 'marker');
  const r = runViewOnTerminal(vl, data, ['view'], { NO_COLOR: '', VL_BANNER_MARKER: marker });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(fs.existsSync(marker), 'the dependency WAS loaded');
});

test('TERM=dumb takes the static banner', () => {
  const { root, data, vl } = scratchPlugin();
  const marker = path.join(root, 'marker');
  const r = runViewOnTerminal(vl, data, ['view'], { TERM: 'dumb', VL_BANNER_MARKER: marker });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(!fs.existsSync(marker), 'the dependency was NOT loaded');
  assert.ok(r.stdout.includes(EXPECTED_BANNER[0]), 'the static banner stands in');
});

test('a missing dependency falls back to the static banner, silently', () => {
  const { data, vl } = scratchPlugin({ fake: false });
  const r = runViewOnTerminal(vl, data, ['view']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes(EXPECTED_BANNER[0]), 'the static banner stands in');
  assert.ok(!r.stderr.includes('ascii.rest'), 'the failure was not announced');
});

test('--json and --condensed carry no banner and no escape byte', () => {
  const dir = scratch();
  writeFixture(dir);
  const json = runView(VL, dir, ['view', '--json']);
  assert.strictEqual(json.status, 0, `exit 0 (stderr: ${json.stderr})`);
  assert.ok(!json.stdout.includes(EXPECTED_BANNER[0]), 'no banner in the envelope');
  assert.ok(!json.stdout.includes(ESC), 'no escape byte');
  const condensed = runView(VL, dir, ['view', '--condensed']);
  assert.strictEqual(condensed.status, 0, `exit 0 (stderr: ${condensed.stderr})`);
  assert.ok(condensed.stdout.startsWith('VIEW-LIMITS | QUOTA REMAINING'), 'the condensed header');
  assert.ok(!condensed.stdout.includes(ESC), 'no escape byte');
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nview banner: ok');
