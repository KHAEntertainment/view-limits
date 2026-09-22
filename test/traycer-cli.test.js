'use strict';
// Real CLI subprocess tests for the Traycer live-read path of
// `bin/vl.js snapshot --json --refresh`. A stub `traycer` binary (node script
// on the child's TRAYCER_CLI) logs every invocation to TRAYCER_STUB_LOG and
// replays canned NDJSON from a per-test response map — so "the snapshot made
// zero Traycer calls" is proven by the log file's absence, and the guard
// preload independently blocks/logs every other side channel.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');
const GUARD = path.join(__dirname, 'guard.cjs');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

const AGENT_ID = 'agent-self-1';
const EPIC_ID = 'epic-1';
const HOST_ID = 'host-uuid-1';
const TS = '2026-09-22T08:00:05.000Z';
const USAGE_MS = 1790066211806;
const USAGE_ISO = new Date(USAGE_MS).toISOString();

const STUB_SOURCE = `'use strict';
// Canned Traycer CLI. Logs argv to TRAYCER_STUB_LOG, then replays the NDJSON
// mapped in the JSON file named by TRAYCER_STUB_RESPONSES (key: argv joined
// by spaces). Unknown commands emit a terminal error record like the real CLI.
const fs = require('fs');
if (process.env.TRAYCER_STUB_LOG) {
  try { fs.appendFileSync(process.env.TRAYCER_STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n'); } catch {}
}
const key = process.argv.slice(2).join(' ');
let spec = null;
try { spec = JSON.parse(fs.readFileSync(process.env.TRAYCER_STUB_RESPONSES, 'utf8'))[key]; } catch {}
if (typeof spec === 'string') spec = { stdout: spec };
const stdout = spec && spec.stdout !== undefined
  ? spec.stdout
  : JSON.stringify({ type: 'result', status: 'error', error: { code: 'E_UNEXPECTED', message: 'stub: unmapped command' }, timestamp: '${TS}' }) + '\\n';
process.stdout.write(stdout);
process.exit(spec && typeof spec.code === 'number' ? spec.code : 0);
`;

const HAPPY_RESPONSES = {
  'agent list --json': JSON.stringify({ type: 'progress', message: 'contacting host', timestamp: '2026-09-22T08:00:01.000Z' }) + '\n' +
    JSON.stringify({
      type: 'result', status: 'ok', timestamp: TS,
      data: {
        caller: { agentId: AGENT_ID, canSendMessages: true }, scope: 'user',
        agents: [
          { id: AGENT_ID, parentId: null, hostId: HOST_ID, isLocal: true, surface: 'gui', harnessId: 'devin', isSelf: true, title: 'Worker', capabilities: { readTranscript: true, sendMessage: true }, active: true, folderPaths: ['/wt/x'], isWorktree: true, runConfig: { model: { kind: 'concrete', slug: 'swe-2-high' }, reasoningEffort: null, fastMode: null } },
          { id: 'agent-tui', parentId: null, hostId: HOST_ID, isLocal: true, surface: 'tui', harnessId: 'claude', isSelf: false, title: 'T', capabilities: { readTranscript: false, sendMessage: false }, active: false, folderPaths: [], isWorktree: false, runConfig: { model: { kind: 'provider-default' }, reasoningEffort: null, fastMode: null } },
        ],
      },
    }) + '\n',
  'agent list-harnesses --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { harnesses: [{ id: 'devin', label: 'Devin', available: true, availabilityPending: false, error: null }] } }) + '\n',
  'agent list-profiles claude --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { providerId: 'claude-code', profiles: [{ selection: { kind: 'ambient' }, label: 'Terminal account', authStatus: 'authenticated', rateLimitStatus: 'ok', usageUpdatedAt: USAGE_MS, isEffectiveLastUsed: true }] } }) + '\n',
  'agent list-profiles codex --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { providerId: 'codex', profiles: [{ selection: { kind: 'ambient' }, label: 'Terminal account', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true }] } }) + '\n',
  'agent list-profiles opencode --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { providerId: 'opencode', profiles: [{ selection: { kind: 'ambient' }, label: 'Terminal account', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true }] } }) + '\n',
  'agent profile-rate-limits claude --profile ambient --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { rateLimits: { provider: 'claude-code', available: true, fiveHour: { usedPercent: 36, resetsAt: 1790067599749, durationMinutes: 300 } }, usageUpdatedAt: USAGE_MS } }) + '\n',
  'agent profile-rate-limits codex --profile ambient --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { rateLimits: { provider: 'codex', available: false, reason: 'unsupported_provider' }, usageUpdatedAt: null } }) + '\n',
  'agent profile-rate-limits opencode --profile ambient --json': JSON.stringify({ type: 'result', status: 'ok', timestamp: TS, data: { rateLimits: { provider: 'opencode', available: false, reason: 'unsupported_provider' }, usageUpdatedAt: null } }) + '\n',
};

// Scratch layout: <dir>/data (CLAUDE_PLUGIN_DATA), <dir>/bin/traycer (stub),
// <dir>/responses.json, <dir>/stub.log.
function fixture(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-traycer-cli-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const stub = path.join(dir, 'bin', 'traycer');
  fs.writeFileSync(stub, '#!/usr/bin/env node\n' + STUB_SOURCE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));
  return dir;
}

function runSnapshot(dir, { args = ['--json'], traycerEnv = false } = {}) {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('TRAYCER_')) delete childEnv[k];
  }
  childEnv.CLAUDE_PLUGIN_DATA = path.join(dir, 'data');
  childEnv.NODE_OPTIONS = `--require=${GUARD}`;
  childEnv.REVIEW_LOG = path.join(dir, 'guard-events.log');
  childEnv.TRAYCER_CLI = path.join(dir, 'bin', 'traycer');
  childEnv.TRAYCER_STUB_LOG = path.join(dir, 'stub.log');
  childEnv.TRAYCER_STUB_RESPONSES = path.join(dir, 'responses.json');
  if (traycerEnv) {
    childEnv.TRAYCER_AGENT_ID = AGENT_ID;
    childEnv.TRAYCER_EPIC_ID = EPIC_ID;
  }
  return spawnSync(process.execPath, [VL, 'snapshot', ...args], {
    env: childEnv, encoding: 'utf8', timeout: 30_000,
  });
}

function stubInvocations(dir) {
  const log = path.join(dir, 'stub.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function guardEvents(dir) {
  const log = path.join(dir, 'guard-events.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

console.log('traycer cli — refresh:false performs zero Traycer invocations');

test('cache-only snapshot with full Traycer env never invokes the CLI; env seeds caller facts', () => {
  const dir = fixture(HAPPY_RESPONSES);
  const r = runSnapshot(dir, { traycerEnv: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.requestedRefresh, false);
  assert.deepStrictEqual(stubInvocations(dir), [], 'refresh:false invoked the Traycer CLI');
  assert.deepStrictEqual(guardEvents(dir), [], 'guard observed forbidden activity');
  // Launch-env identity is request-local evidence — present even cache-only.
  assert.strictEqual(doc.caller.agentId.value, AGENT_ID);
  assert.strictEqual(doc.caller.agentId.source, 'traycer-env');
  assert.strictEqual(doc.caller.epicId.value, EPIC_ID);
  assert.strictEqual(doc.caller.ade.value, 'traycer');
  assert.strictEqual(doc.caller.surface.value, 'cli', 'authoritative surface needs refresh');
  assert.deepStrictEqual(doc.sessions, [], 'no live rows cache-only');
  assert.ok(!doc.diagnostics.some((d) => d.code === 'live-reads-unavailable'));
  // No filesystem writes under the data dir either.
  const dataFiles = fs.readdirSync(path.join(dir, 'data'));
  assert.deepStrictEqual(dataFiles, [], `cache-only snapshot wrote files: ${dataFiles}`);
});

test('--refresh without a Traycer identity → live-reads-unavailable, stub untouched', () => {
  const dir = fixture(HAPPY_RESPONSES);
  const r = runSnapshot(dir, { args: ['--json', '--refresh'], traycerEnv: false });
  assert.strictEqual(r.status, 0);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.requestedRefresh, true);
  assert.ok(doc.diagnostics.some((d) => d.code === 'live-reads-unavailable'));
  assert.match(r.stderr, /live-reads-unavailable/);
  assert.deepStrictEqual(stubInvocations(dir), [], 'no identity must mean zero Traycer invocations');
  assert.deepStrictEqual(guardEvents(dir), []);
});

console.log('\ntraycer cli — refresh:true bounded live reads');

test('happy path: caller overlay, session/harness/profile rows, native usage timestamps', () => {
  const dir = fixture(HAPPY_RESPONSES);
  const r = runSnapshot(dir, { args: ['--json', '--refresh'], traycerEnv: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.requestedRefresh, true);
  assert.deepStrictEqual(doc.diagnostics, [], `unexpected diagnostics: ${r.stderr}`);

  // Authoritative caller row resolved by exact id match.
  assert.strictEqual(doc.caller.agentId.value, AGENT_ID);
  assert.strictEqual(doc.caller.agentId.source, 'traycer-cli');
  assert.strictEqual(doc.caller.surface.value, 'gui');
  assert.strictEqual(doc.caller.harness.value, 'devin');
  assert.deepStrictEqual(doc.caller.configuredModel.value, { kind: 'concrete', slug: 'swe-2-high' });
  assert.strictEqual(doc.caller.selectedProfile.provenance, 'unknown');
  assert.strictEqual(doc.caller.effectiveModel.provenance, 'unknown');

  // Sessions: both agents as separate rows keyed host+ade+epic+agent.
  assert.strictEqual(doc.sessions.length, 2);
  const self = doc.sessions.find((s) => s.key.agentId === AGENT_ID);
  assert.deepStrictEqual(self.key, { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: AGENT_ID });
  assert.strictEqual(self.surface.value, 'gui');
  assert.strictEqual(self.active.value, true);
  const tui = doc.sessions.find((s) => s.key.agentId === 'agent-tui');
  assert.strictEqual(tui.surface.value, 'tui');
  assert.deepStrictEqual(tui.configuredModel.value, { kind: 'provider-default' });

  // Harness catalog row keyed by caller surface, with sessionRefs attached.
  const devin = doc.harnesses.find((h) => h.key.harness === 'devin');
  assert.strictEqual(devin.key.surface, 'gui');
  assert.strictEqual(devin.available.value, true);
  assert.strictEqual(devin.sessionRefs.length, 1);

  // Profiles: ambient rows per harness; last-used ≠ selected.
  const claude = doc.profiles.find((p) => p.key.provider === 'claude-code');
  assert.strictEqual(claude.key.profileId, 'ambient');
  assert.strictEqual(claude.isEffectiveLastUsed.value, true);
  assert.strictEqual(claude.usageUpdatedAt.value, USAGE_ISO);
  assert.strictEqual(claude.nativeRateLimits.observedAt, USAGE_ISO, 'native observedAt = provider usageUpdatedAt');
  assert.strictEqual(claude.nativeRateLimits.value.fiveHour.usedPercent, 36);
  const codex = doc.profiles.find((p) => p.key.provider === 'codex');
  assert.strictEqual(codex.usageUpdatedAt.reason, 'native-usage-unobserved');
  assert.strictEqual(codex.nativeRateLimits.observedAt, null);

  // The read set is exactly the bounded supported reads, each once.
  const invocations = stubInvocations(dir).map((a) => a.join(' ')).sort();
  assert.deepStrictEqual(invocations, [
    'agent list --json',
    'agent list-harnesses --json',
    'agent list-profiles claude --json',
    'agent list-profiles codex --json',
    'agent list-profiles opencode --json',
    'agent profile-rate-limits claude --profile ambient --json',
    'agent profile-rate-limits codex --profile ambient --json',
    'agent profile-rate-limits opencode --profile ambient --json',
  ]);
});

test('one malformed read degrades its section; siblings survive; diagnostics on stderr', () => {
  const dir = fixture({
    ...HAPPY_RESPONSES,
    'agent list --json': 'this is not ndjson\n',
  });
  const r = runSnapshot(dir, { args: ['--json', '--refresh'], traycerEnv: true });
  assert.strictEqual(r.status, 0);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.diagnostics.some((d) => d.code === 'traycer-output-malformed' && d.scope === 'sessions'));
  assert.match(r.stderr, /traycer-output-malformed/);
  assert.deepStrictEqual(doc.sessions, []);
  assert.strictEqual(doc.caller.surface.value, 'cli', 'no overlay without a verified caller');
  assert.strictEqual(doc.caller.agentId.value, AGENT_ID, 'env-supplied identity still reported');
  assert.ok(doc.profiles.length >= 3, 'profile reads unaffected');
  // progress-line timestamp must never surface as an observation time
  assert.ok(!JSON.stringify(doc).includes('T08:00:01'), 'progress timestamp leaked into facts');
});

test('missing CLI binary → traycer-cli-missing diagnostics, snapshot still exits 0', () => {
  const dir = fixture(HAPPY_RESPONSES);
  fs.unlinkSync(path.join(dir, 'bin', 'traycer'));
  const r = runSnapshot(dir, { args: ['--json', '--refresh'], traycerEnv: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.diagnostics.some((d) => d.code === 'traycer-cli-missing'));
  assert.deepStrictEqual(doc.sessions, []);
  assert.deepStrictEqual(doc.profiles, []);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall traycer-cli tests passed');
