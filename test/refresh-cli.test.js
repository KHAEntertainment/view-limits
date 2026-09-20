'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-refresh-cli-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/refresh-cli-preload.cjs');
const env = { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${preload}` };
const route = { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 123 };
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routes: [route] }));
const old = { updatedAt: '2000-01-01T00:00:00Z', routes: { 'kimi-code-plan': {
  freshUntil: '2000-01-01T00:00:00Z', status: { state: 'healthy' },
}, invalidNull: null, invalidArray: [], invalidPrimitive: 3 } };
fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(old));
const events = () => {
  try { return fs.readFileSync(path.join(dir, 'events'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'event barrier timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function run(args, extra = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 5000, ...extra });
  assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  return result;
}
const children = [];
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
}
(async () => {
  try {
    const report = run(['report']);
    assert.match(report.stdout, /kimi-code-plan: healthy/);
    assert.doesNotMatch(report.stdout, /invalidNull|invalidArray|invalidPrimitive/);
    const jsonReport = JSON.parse(run(['report', '--json']).stdout);
    assert.deepStrictEqual(Object.keys(jsonReport.routes), ['kimi-code-plan']);
    const owner = spawn(process.execPath, [cli, 'refresh', '--quiet'], { env, stdio: 'ignore' });
    children.push(owner);
    await until(() => events().some(e => e.kind === 'provider' && e.pid === owner.pid));
    const manual = run(['refresh']);
    assert.match(manual.stdout, /refresh already in progress/);
    assert.match(manual.stdout, /2000-01-01/);
    assert.doesNotMatch(manual.stdout, /invalidNull|invalidArray|invalidPrimitive/);
    const hooks = require('../hooks/hooks.json');
    const sessionArgs = hooks.hooks.SessionStart[0].hooks[0].args.slice(1);
    assert.deepStrictEqual(sessionArgs, ['refresh', '--quiet']);
    run(sessionArgs);
    const input = JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } });
    const gate = run(['gate'], { input });
    assert.ok(!JSON.parse(gate.stdout).hookSpecificOutput.permissionDecision);
    const spawned = events().find(e => e.kind === 'spawn');
    assert.ok(spawned && spawned.detached && spawned.stdio === 'ignore');
    await until(() => events().some(e => e.kind === 'exit' && e.pid === spawned.child));
    assert.strictEqual(events().filter(e => e.kind === 'provider').length, 1);
    // Killing the owner before it publishes must leave the old cache intact.
    await kill(owner);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'))), old);
    fs.writeFileSync(path.join(dir, 'release'), 'go');
    run(['refresh', '--quiet']);
    assert.strictEqual(events().filter(e => e.kind === 'provider').length, 2);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json')));
    const entry = doc.routes[route.id];
    assert.strictEqual(entry.status.state, 'healthy');
    // Existing entryFor reads its two clocks separately; allow that elapsed
    // fraction of a second without masking a different configured TTL.
    const ttl = Date.parse(entry.freshUntil) - Date.parse(entry.observedAt);
    assert.ok(ttl >= 123000 && ttl < 124000, `unexpected TTL ${ttl}`);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'refresh-workers')), []);
    // Storage failure in scheduling or admission must not create a deny.
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(old));
    const deniedEnv = { ...env, VL_FAIL_SCHEDULING: '1' };
    const failure = run(['gate'], { input, env: deniedEnv });
    assert.ok(!JSON.parse(failure.stdout).hookSpecificOutput.permissionDecision);
    const before = events().filter(e => e.kind === 'provider').length;
    const unavailable = run(['refresh'], { env: deniedEnv });
    assert.match(unavailable.stdout, /refresh unavailable/);
    assert.strictEqual(events().filter(e => e.kind === 'provider').length, before);
    console.log('refresh CLI ownership, recovery, entrypoints and storage failure: PASS');
  } finally {
    await Promise.all(children.map(kill));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
