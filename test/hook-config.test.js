'use strict';
// Real hook entrypoints with isolated non-secret config, no credentials/network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { once } = require('events');
const { decide } = require('../lib/gate');
const hooks = require('../hooks/hooks.json');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-hook-config-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const configPath = path.join(dir, 'config.json');
const statusPath = path.join(dir, 'status.json');
const tracePath = path.join(dir, 'trace.log');
const eventPath = path.join(dir, 'events');
const guard = path.join(__dirname, 'guard.cjs');
const preload = path.join(__dirname, 'fixtures/refresh-cli-preload.cjs');
const route = { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' } };
const now = Date.parse('2026-09-19T00:00:00Z');
const entry = {
  freshUntil: new Date(now + 60000).toISOString(),
  status: { state: 'exhausted', resetAt: '2026-09-19T05:00:00Z' },
};
const env = {
  PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir,
  NODE_OPTIONS: `--require=${guard}`, REVIEW_NOW: String(now), REVIEW_LOG: tracePath,
};
const refreshEnv = { ...env, NODE_OPTIONS: `--require=${preload}` };
const matchers = hooks.hooks.PreToolUse[0].matcher.split('|');
const gateArgs = hooks.hooks.PreToolUse[0].hooks[0].args.slice(1);
const refreshArgs = hooks.hooks.SessionStart[0].hooks[0].args.slice(1);
const silent = result => {
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
};
function writeConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}
function cache(value = entry) {
  fs.writeFileSync(statusPath, JSON.stringify({ routes: { [route.id]: value } }));
}
function resetLog(file) {
  fs.rmSync(file, { force: true });
}
function log(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env, encoding: 'utf8', timeout: 5000, ...options,
  });
  assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  return result;
}
function gate(tool = 'Agent') {
  return run(gateArgs, { input: JSON.stringify({ tool_name: tool, tool_input: { model: 'kimi-k2' } }) });
}
function settings(mode, injectContext) {
  return { gate: { mode, injectContext } };
}

(async () => {
  try {
    // Missing/malformed controls must remain silent, even with fresh exhaustion.
    cache();
    const badValues = [undefined, null, false, true, 0, 1, '', 'no', 'DENY', {}, []];
    for (const cfg of [undefined, {}, null, [], false, 'deny', 42,
      ...badValues.map(mode => settings(mode, true)),
      ...[null, false, 'deny', 42, []].map(value => ({ gate: value })),
    ]) {
      if (cfg === undefined) fs.rmSync(configPath, { force: true });
      else writeConfig(cfg);
      resetLog(tracePath);
      silent(gate());
      assert.deepStrictEqual(log(tracePath), [], JSON.stringify(cfg));
      assert.ok(!fs.existsSync(path.join(dir, 'refresh.scheduled')));
    }
    fs.writeFileSync(configPath, '{broken');
    silent(gate());
    // An unreadable config (a directory) also fails open.
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    silent(gate());
    fs.rmdirSync(configPath);

    for (const tool of matchers) {
      for (const mode of ['off', 'advisory', 'deny']) {
        for (const injectContext of [false, true]) {
          writeConfig(settings(mode, injectContext));
          resetLog(tracePath);
          const result = gate(tool);
          if (mode === 'deny') {
            assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', tool);
          } else if (mode === 'advisory' && injectContext) {
            const output = JSON.parse(result.stdout).hookSpecificOutput;
            assert.strictEqual(output.hookEventName, 'PreToolUse');
            assert.strictEqual(output.permissionDecision, undefined);
            assert.match(output.additionalContext, /prefer another plan/);
            assert.doesNotMatch(output.additionalContext, /wait|reset/i);
          } else silent(result);
          assert.deepStrictEqual(log(tracePath), [], `${tool} ${mode}: no refresh/network/vault`);
        }
      }
    }

    // Off exits before waiting on hook stdin to close.
    writeConfig(settings('off', true));
    const child = spawn(process.execPath, [cli, ...gateArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    let timeout;
    try {
      const [code] = await Promise.race([
        once(child, 'close'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('off waited for stdin')), 2000); }),
      ]);
      assert.strictEqual(code, 0);
      assert.strictEqual(stdout, '');
      assert.strictEqual(stderr, '');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill('SIGKILL');
      child.stdin.destroy();
    }

    // Advisory only injects when fresh AND exhausted. Deny context is opt-in.
    for (const state of ['healthy', 'constrained', 'unknown', 'exhausted']) {
      for (const fresh of [false, true]) {
        const value = { ...entry, status: { state }, freshUntil: new Date(now + (fresh ? 60000 : -1)).toISOString() };
        for (const mode of ['off', 'advisory', 'deny']) {
          for (const injectContext of [undefined, false, null, 'true', 1, {}, [], true]) {
            const result = decide({ route, entry: value, now, config: settings(mode, injectContext) });
            const denies = mode === 'deny' && fresh && state === 'exhausted';
            assert.strictEqual(result.action, denies ? 'deny' : 'allow');
            const context = injectContext === true && !denies &&
              (mode === 'deny' || (mode === 'advisory' && fresh && state === 'exhausted'));
            assert.strictEqual(Object.hasOwn(result, 'context'), context);
            if (context) {
              assert.match(result.context, /prefer another plan/);
              assert.doesNotMatch(result.context, /wait|reset/i);
            }
            if (mode === 'off') assert.deepStrictEqual(result, { action: 'allow' });
          }
        }
      }
    }
    for (const config of [undefined, null, false, [], {}, ...badValues.map(mode => settings(mode, true))]) {
      assert.deepStrictEqual(decide({ route, entry, now, config }), { action: 'allow' });
    }
    for (const value of [null, {}, { freshUntil: 'bad', status: { state: 'exhausted' } }]) {
      const result = decide({ route, entry: value, now, config: settings('advisory', true) });
      assert.strictEqual(result.action, 'allow');
      assert.ok(!Object.hasOwn(result, 'context'));
    }
    for (const injectContext of [undefined, false, null, 'true', 1, {}, []]) {
      writeConfig(settings('deny', injectContext));
      cache({ ...entry, status: { state: 'healthy' } });
      silent(gate());
    }

    // Disabled SessionStart refresh touches no vault, provider, or worker lock.
    assert.deepStrictEqual(refreshArgs, ['refresh', '--quiet', '--session-start']);
    const before = fs.readFileSync(statusPath, 'utf8');
    for (const value of badValues.filter(value => value !== true)) {
      writeConfig({ refreshOnSessionStart: value });
      resetLog(tracePath);
      silent(run(refreshArgs));
      assert.deepStrictEqual(log(tracePath), []);
      assert.strictEqual(fs.readFileSync(statusPath, 'utf8'), before);
      assert.ok(!fs.existsSync(path.join(dir, 'refresh-workers')));
    }
    for (const raw of [null, 'null', '[]', 'false', '42', '{broken']) {
      if (raw === null) fs.rmSync(configPath, { force: true });
      else fs.writeFileSync(configPath, raw);
      silent(run(refreshArgs));
    }

    // Manual (including quiet) refresh still calls the provider with flags off.
    fs.writeFileSync(path.join(dir, 'release'), 'go');
    for (const enabled of [false, true]) {
      writeConfig({ routes: [route], ...settings('off', false), refreshOnSessionStart: enabled });
      resetLog(eventPath);
      silent(run(refreshArgs, { env: refreshEnv }));
      assert.strictEqual(log(eventPath).filter(event => event.kind === 'provider').length, enabled ? 1 : 0);
      for (const args of [['refresh'], ['refresh', '--quiet']]) {
        resetLog(eventPath);
        run(args, { env: refreshEnv });
        assert.strictEqual(log(eventPath).filter(event => event.kind === 'provider').length, 1);
      }
    }

    // CLI output reports normalized controls without consulting real secrets.
    for (const mode of ['off', 'advisory', 'deny']) {
      writeConfig({ ...settings(mode, true), refreshOnSessionStart: true });
      const cfg = JSON.parse(run(['config'], { env: refreshEnv }).stdout);
      assert.strictEqual(cfg.gate.mode, mode);
      assert.strictEqual(cfg.gate.injectContext, true);
      assert.strictEqual(cfg.refreshOnSessionStart, true);
    }
    for (const raw of [null, '{}', 'null', '[]', '{broken',
      JSON.stringify({ gate: { mode: 'bad', injectContext: 'true' }, refreshOnSessionStart: 'true' }),
      JSON.stringify({ gate: null }),
    ]) {
      if (raw === null) fs.rmSync(configPath, { force: true });
      else fs.writeFileSync(configPath, raw);
      const cfg = JSON.parse(run(['config'], { env: refreshEnv }).stdout);
      assert.strictEqual(cfg.gate.mode, 'off');
      assert.strictEqual(cfg.gate.injectContext, false);
      assert.strictEqual(cfg.refreshOnSessionStart, false);
    }
    assert.deepStrictEqual(hooks.hooks.SessionStart[1].hooks[0], {
      type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/vl.js', 'session-start'], timeout: 5,
    });
    console.log('hook modes, malformed config, context opt-in, SessionStart and manual refresh: PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
