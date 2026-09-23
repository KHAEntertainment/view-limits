'use strict';
// Supported Traycer CLI adapter — an ADE/runtime adapter, NOT a provider
// adapter (it is never registered in lib/adapters). Every piece of Traycer
// knowledge — environment variable names, command syntax, NDJSON framing, the
// terminal-result contract, subprocess deadlines — lives inside this module;
// the snapshot composer consumes only validated facts, rows, and scoped
// diagnostics.
//
// Live-read policy (v2 runtime contract — Traycer adapter boundary):
//   * The composer invokes readTraycerRuntime only on `refresh: true`. When no
//     Traycer caller identity can be formed (no supplied agentId/epicId and no
//     TRAYCER_AGENT_ID/TRAYCER_EPIC_ID launch environment) the only product is
//     a live-reads-unavailable diagnostic — nothing is spawned.
//   * Reads are bounded: a per-command deadline, at most MAX_CONCURRENT
//     subprocesses, identical command keys coalesced within one call:
//       agent list --json                                caller + session inventory
//       agent list-harnesses --json                    enabled-harness catalog
//       agent list-profiles <h> --json                 h in PROFILE_HARNESSES
//       agent profile-rate-limits <h> --profile <sel>  only for each harness's
//                                                      isEffectiveLastUsed profile
//   * The CLI emits NDJSON: any number of non-terminal records (progress)
//     followed by exactly one {"type":"result","status","data"|"error",
//     "timestamp"} record. Non-terminal records are ignored — their timestamps
//     never mark observation freshness. The terminal timestamp is the read's
//     retrieval time only.
//   * Caller resolution is exact: a supplied agentId must equal the launch
//     env's TRAYCER_AGENT_ID (when present) and the CLI-reported
//     caller.agentId, and the caller row is found by id — never by isSelf.
//     Mismatches withhold authoritative caller facts; they never borrow
//     another row.
//   * runConfig.model populates configuredModel only; provider-default stays
//     { kind: 'provider-default' } and never becomes a concrete effective or
//     default model. effectiveModel, defaultModel, selectedProfile, and
//     selectedAccount have no verified session-bound source in the installed
//     build, so the adapter never emits them.
//   * Native usage facts key observedAt to the provider's usageUpdatedAt
//     (epoch ms or ISO string); a null usageUpdatedAt leaves usage facts
//     unknown — it never becomes fresh capacity.
//   * Row shapes follow the runtime.json sidecar contracts:
//       sessions  { host, ade, epicId, agentId }   host = Traycer hostId
//       harnesses { host, harness, surface }
//       profiles  { host, provider, profileId }
//     so live rows merge with cached rows by composite key.
//   * A failed/missing/timed-out/malformed read degrades only its own section;
//     sibling facts survive and the diagnostic is a fixed safe summary.

const { spawn } = require('child_process');
const { parseStrictIsoTimestamp } = require('./gate');

const ADE_ID = 'traycer';
const SOURCE = 'traycer-cli';
const ENV_SOURCE = 'traycer-env';
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 2;
const MAX_STDOUT_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

// Harnesses with a supported native-profile catalog read in this slice.
const PROFILE_HARNESSES = ['claude', 'codex', 'opencode'];

const SUMMARIES = {
  'live-reads-unavailable': 'live refresh was requested but no supported live source was available for this caller; showing cached facts only.',
  'traycer-cli-missing': 'the supported Traycer CLI is not installed or not on PATH; Traycer runtime facts are unknown.',
  'traycer-read-timeout': 'a bounded Traycer CLI read exceeded its deadline; that section\u2019s live facts are unknown.',
  'traycer-read-failed': 'a Traycer CLI read failed; that section\u2019s live facts are unknown.',
  'traycer-output-malformed': 'a Traycer CLI read returned unusable output; that section\u2019s live facts are unknown.',
  'traycer-caller-mismatch': 'supplied caller identity does not match the Traycer-verified identity; authoritative caller facts are withheld.',
  'traycer-caller-row-absent': 'the Traycer-verified caller has no own row in the agent listing; caller row facts are unknown.',
  'traycer-epic-unverified': 'the caller epic id was supplied without launch-environment evidence; session rows were withheld rather than keyed on an unverified claim.',
  'traycer-host-unresolved': 'no host identity could be confirmed for Traycer catalog rows; they were withheld.',
};

const FAILURE_DIAG = {
  missing: 'traycer-cli-missing',
  timeout: 'traycer-read-timeout',
  malformed: 'traycer-output-malformed',
  failed: 'traycer-read-failed',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Same six-key fact envelope as lib/runtime-snapshot.js (helpers are local,
// mirroring lib/runtime-sidecar.js, so this module stays self-contained).
function fact(value, provenance, { source = null, observedAt = null, freshUntil = null } = {}) {
  return { value, provenance, source, observedAt, freshUntil, reason: null };
}

function observed(value, observedAt) {
  return fact(value, 'observed', { source: SOURCE, observedAt });
}

function unknown(reason) {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

function diag(code, scope) {
  return { code, scope, summary: SUMMARIES[code] || null };
}

// ---- callerContext / environment -------------------------------------------

// Request-local Traycer identity for the caller section: the launch
// environment's IDs are evidence about this process, reported from
// 'traycer-env'. The CLI wrapper seeds callerContext with this so the caller
// section carries launch identity even on a cache-only read.
function traycerEnvCallerContext(env = process.env) {
  const out = {};
  const agentId = env && env.TRAYCER_AGENT_ID;
  const epicId = env && env.TRAYCER_EPIC_ID;
  if (nonEmptyString(agentId)) {
    out.ade = { value: ADE_ID, provenance: 'observed', source: ENV_SOURCE };
    out.agentId = { value: agentId, provenance: 'observed', source: ENV_SOURCE };
  }
  if (nonEmptyString(epicId)) {
    out.epicId = { value: epicId, provenance: 'observed', source: ENV_SOURCE };
  }
  return out;
}

// Read a callerContext field that may be a primitive or a fact-shaped object.
function suppliedValue(ctx, field) {
  if (!isPlainObject(ctx)) return null;
  const v = ctx[field];
  if (nonEmptyString(v)) return v;
  if (isPlainObject(v) && nonEmptyString(v.value)) return v.value;
  return null;
}

// ---- NDJSON terminal-result contract ----------------------------------------

// Parse a --json command's stdout: any number of non-terminal event records
// (progress etc.) then exactly one {"type":"result"} record. A non-JSON line,
// zero or multiple terminal records, or an unknown status all make the output
// malformed. Only the terminal record's timestamp is returned — and only as
// retrieval time, never as observation freshness.
function parseTerminalResult(stdout) {
  const results = [];
  let malformed = false;
  for (const raw of String(stdout == null ? '' : stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (isPlainObject(ev) && ev.type === 'result') results.push(ev);
  }
  if (malformed || results.length !== 1) return { failure: 'malformed' };
  const r = results[0];
  if (r.status === 'ok') {
    const retrievedAt = nonEmptyString(r.timestamp) && parseStrictIsoTimestamp(r.timestamp) !== null
      ? r.timestamp
      : null;
    return { ok: true, data: r.data, retrievedAt };
  }
  if (r.status === 'error') return { failure: 'failed' };
  return { failure: 'malformed' };
}

// ---- bounded subprocess runner ----------------------------------------------

// One bounded CLI invocation. The binary resolves from env.TRAYCER_CLI (the
// name Traycer exports to agent processes) with a 'traycer' PATH fallback.
// Never rejects; the outcome is a plain result object for the classifier.
function defaultRun(args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const bin = env && nonEmptyString(env.TRAYCER_CLI) ? env.TRAYCER_CLI : 'traycer';
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let killGrace = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      resolve(out);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // A wedged child that never emits close/error must not hang the read:
      // force-settle a short grace after the kill.
      killGrace = setTimeout(() => finish({ stdout, stderr, timedOut: true, overflow }), 2000);
      if (killGrace.unref) killGrace.unref();
    }, timeoutMs);
    if (child.stdout) {
      child.stdout.on('data', (c) => {
        stdout += c;
        if (stdout.length > MAX_STDOUT_CHARS && !overflow) {
          overflow = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (c) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += c;
      });
    }
    child.on('error', (error) => finish({ error, timedOut }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, overflow }));
  });
}

// Run one command and classify the outcome.
//   ok:      { ok: true, data, retrievedAt }
//   failure: { failure: 'missing' | 'timeout' | 'malformed' | 'failed' }
async function runCommand(runner, args, opts) {
  let res;
  try {
    res = await runner(args, opts);
  } catch {
    return { failure: 'failed' };
  }
  if (!isPlainObject(res)) return { failure: 'failed' };
  if (res.timedOut) return { failure: 'timeout' };
  if (res.error && res.error.code === 'ENOENT') return { failure: 'missing' };
  if (res.error) return { failure: 'failed' };
  if (res.overflow) return { failure: 'malformed' };
  if (typeof res.code === 'number' && res.code !== 0) return { failure: 'failed' };
  return parseTerminalResult(res.stdout);
}

// Run task functions with a hard concurrency cap.
async function pooled(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---- row builders ------------------------------------------------------------

function stringFact(v, observedAt) {
  return nonEmptyString(v) ? observed(v, observedAt) : unknown('traycer-field-absent');
}

function boolFact(v, observedAt) {
  if (typeof v === 'boolean') return observed(v, observedAt);
  return unknown(v === undefined || v === null ? 'traycer-field-absent' : 'traycer-field-unconforming');
}

// runConfig.model is the stored run tuple: concrete slug or provider-default.
// It fills configuredModel only — never effective/default.
function modelRefFact(model, observedAt) {
  if (!isPlainObject(model)) return unknown('traycer-field-absent');
  if (model.kind === 'concrete' && nonEmptyString(model.slug)) {
    return observed({ kind: 'concrete', slug: model.slug }, observedAt);
  }
  if (model.kind === 'provider-default') return observed({ kind: 'provider-default' }, observedAt);
  return unknown('traycer-field-unconforming');
}

// usageUpdatedAt is epoch ms (or a strict ISO string) — the provider's own
// observation time. Null/absent stays unknown; nothing substitutes a fresher
// timestamp for it.
function usageIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (nonEmptyString(v) && parseStrictIsoTimestamp(v) !== null) return v;
  return null;
}

function usageTimeFact(v) {
  const iso = usageIso(v);
  if (iso !== null) return fact(iso, 'observed', { source: SOURCE, observedAt: iso });
  if (v === null || v === undefined) return unknown('native-usage-unobserved');
  return unknown('traycer-field-unconforming');
}

// Concrete profile selection → profileId key component.
//   { kind: 'ambient' }               → 'ambient'
//   { kind: 'profile', profileId }    → the managed profile id
// Anything else is unconforming and the row is dropped.
function profileIdOf(selection) {
  if (!isPlainObject(selection)) return null;
  if (selection.kind === 'ambient') return 'ambient';
  if (selection.kind === 'profile' && nonEmptyString(selection.profileId)) return selection.profileId;
  return null;
}

function sessionKeyOf(agent, epicId) {
  return { host: agent.hostId, ade: ADE_ID, epicId, agentId: agent.id };
}

function sessionRow(agent, epicId, observedAt) {
  const rc = isPlainObject(agent.runConfig) ? agent.runConfig : null;
  return {
    key: sessionKeyOf(agent, epicId),
    surface: stringFact(agent.surface, observedAt),
    harness: stringFact(agent.harnessId, observedAt),
    title: stringFact(agent.title, observedAt),
    active: boolFact(agent.active, observedAt),
    isSelf: boolFact(agent.isSelf, observedAt),
    isLocal: boolFact(agent.isLocal, observedAt),
    isWorktree: boolFact(agent.isWorktree, observedAt),
    configuredModel: modelRefFact(rc && rc.model, observedAt),
    reasoningEffort: rc && rc.reasoningEffort != null
      ? stringFact(rc.reasoningEffort, observedAt)
      : unknown('traycer-field-absent'),
    folderPaths: Array.isArray(agent.folderPaths)
      ? observed(agent.folderPaths.filter(nonEmptyString), observedAt)
      : unknown('traycer-field-unconforming'),
  };
}

// Authoritative caller overlay — emitted only when the supplied identity was
// verified against the launch environment and the CLI's own caller.agentId.
// Without a self row only the verified identity fields are overlaid.
// epicId is NEVER stamped as a CLI observation: the CLI does not return an
// epic id, so the only honest sources are the launch environment
// ('traycer-env') or the caller's own claim (left untouched in callerContext).
function callerOverlay(row, agentId, envEpicId, observedAt) {
  const overlay = {
    ade: observed(ADE_ID, observedAt),
    agentId: observed(agentId, observedAt),
  };
  if (nonEmptyString(envEpicId)) {
    overlay.epicId = fact(envEpicId, 'observed', { source: ENV_SOURCE });
  }
  if (row) {
    overlay.surface = stringFact(row.surface, observedAt);
    overlay.harness = stringFact(row.harnessId, observedAt);
    overlay.configuredModel = modelRefFact(isPlainObject(row.runConfig) ? row.runConfig.model : null, observedAt);
  }
  return overlay;
}

// ---- main read ---------------------------------------------------------------

// Bounded Traycer live read. Returns plain data — never throws, never mutates
// Traycer state, never touches credentials or the host database.
//   → { caller, sessions, harnesses, profiles, diagnostics }
// `caller` is a fact overlay for the snapshot's caller section, or null when
// the caller identity could not be verified.
async function readTraycerRuntime({
  callerContext = null,
  env = process.env,
  run,
  timeoutMs = COMMAND_TIMEOUT_MS,
  concurrency = MAX_CONCURRENT,
} = {}) {
  const out = { caller: null, sessions: [], harnesses: [], profiles: [], diagnostics: [] };
  const pushDiag = (code, scope) => out.diagnostics.push(diag(code, scope));

  const suppliedAgentId = suppliedValue(callerContext, 'agentId');
  const suppliedEpicId = suppliedValue(callerContext, 'epicId');
  const suppliedHost = suppliedValue(callerContext, 'host');
  const suppliedSurface = suppliedValue(callerContext, 'surface');
  const envAgentId = env && nonEmptyString(env.TRAYCER_AGENT_ID) ? env.TRAYCER_AGENT_ID : null;
  const envEpicId = env && nonEmptyString(env.TRAYCER_EPIC_ID) ? env.TRAYCER_EPIC_ID : null;

  // The subprocess always resolves under the launch environment; supplied
  // IDs fill gaps only. `queryAgentId`/`queryEpicId` are the identity the CLI
  // will actually use. A supplied value that disagrees with the env can never
  // be confirmed and is a caller mismatch, not a silently re-scoped read.
  const queryAgentId = envAgentId || suppliedAgentId;
  const queryEpicId = envEpicId || suppliedEpicId;
  if (!queryAgentId || !queryEpicId) {
    pushDiag('live-reads-unavailable', 'envelope');
    return out;
  }
  // Only a launch-environment epic is verified identity evidence: the CLI
  // output never echoes an epic id, so a supplied-only epic is a claim. The
  // read still runs under it (the subprocess needs a scope), but the claim
  // must not propagate into session row keys or sessionRefs.
  const epicVerified = envEpicId !== null;

  let mismatch = false;
  if ((envAgentId && suppliedAgentId && envAgentId !== suppliedAgentId) ||
      (envEpicId && suppliedEpicId && envEpicId !== suppliedEpicId)) {
    mismatch = true;
    pushDiag('traycer-caller-mismatch', 'caller');
  }

  const runner = run || defaultRun;
  const childEnv = Object.assign({}, env);
  if (!envAgentId) childEnv.TRAYCER_AGENT_ID = queryAgentId;
  if (!envEpicId) childEnv.TRAYCER_EPIC_ID = queryEpicId;

  // Identical command keys coalesce to one subprocess within this read.
  const inflight = new Map();
  const invoke = (args) => {
    const key = JSON.stringify(args);
    if (!inflight.has(key)) inflight.set(key, runCommand(runner, args, { env: childEnv, timeoutMs }));
    return inflight.get(key);
  };
  const failDiag = (result, scope) => pushDiag(FAILURE_DIAG[result.failure] || 'traycer-read-failed', scope);

  // Wave 1 — independent reads, at most `concurrency` subprocesses.
  const wave1 = [
    { name: 'agents', scope: 'sessions', args: ['agent', 'list', '--json'] },
    { name: 'harnesses', scope: 'harnesses', args: ['agent', 'list-harnesses', '--json'] },
    ...PROFILE_HARNESSES.map((h) => ({
      name: `profiles:${h}`, scope: `profiles:${h}`, harness: h,
      args: ['agent', 'list-profiles', h, '--json'],
    })),
  ];
  await pooled(wave1, concurrency, async (t) => { t.result = await invoke(t.args); });
  const [agentsTask, harnessTask] = wave1;
  const profileTasks = wave1.slice(2);

  // --- agent list → caller overlay + session rows + harness usage ----------
  let keyHost = suppliedHost;
  let callerSurface = null;
  const usage = new Map(); // JSON [host,harness,surface] → { key, refs }
  if (agentsTask.result.ok) {
    const data = agentsTask.result.data;
    const ts = agentsTask.result.retrievedAt;
    if (!isPlainObject(data) || !isPlainObject(data.caller) || !Array.isArray(data.agents)) {
      pushDiag('traycer-output-malformed', 'sessions');
    } else {
      const cliCallerId = nonEmptyString(data.caller.agentId) ? data.caller.agentId : null;
      let verified = false;
      if (cliCallerId !== queryAgentId) {
        if (!mismatch) { mismatch = true; pushDiag('traycer-caller-mismatch', 'caller'); }
      } else {
        verified = true;
      }
      let invalid = false;
      let localHostId = null;
      let selfRow = null;
      for (const a of data.agents) {
        if (!isPlainObject(a) || !nonEmptyString(a.id) || !nonEmptyString(a.hostId)) {
          invalid = true;
          continue;
        }
        if (a.isLocal === true && !localHostId) localHostId = a.hostId;
        if (a.id === queryAgentId) selfRow = a;
        if (epicVerified) {
          const key = sessionKeyOf(a, queryEpicId);
          out.sessions.push(sessionRow(a, queryEpicId, ts));
          if (nonEmptyString(a.harnessId) && nonEmptyString(a.surface)) {
            const sig = JSON.stringify([a.hostId, a.harnessId, a.surface]);
            if (!usage.has(sig)) usage.set(sig, { key: { host: a.hostId, harness: a.harnessId, surface: a.surface }, refs: [] });
            usage.get(sig).refs.push(key);
          }
        }
      }
      if (!epicVerified) pushDiag('traycer-epic-unverified', 'sessions');
      // The catalog read answered for the host it ran on: prefer the verified
      // caller row's host, then the supplied hostname, then any local row's
      // hostId as a last resort (a foreign isLocal row still names this host).
      keyHost = (selfRow && selfRow.hostId) || keyHost || localHostId;
      if (invalid) pushDiag('traycer-output-malformed', 'sessions');
      if (verified && !mismatch) {
        if (selfRow) {
          out.caller = callerOverlay(selfRow, queryAgentId, envEpicId, ts);
          callerSurface = nonEmptyString(selfRow.surface) ? selfRow.surface : null;
        } else {
          out.caller = callerOverlay(null, queryAgentId, envEpicId, ts);
          pushDiag('traycer-caller-row-absent', 'caller');
        }
      }
    }
  } else {
    failDiag(agentsTask.result, 'sessions');
  }

  // --- harness catalog → rows keyed by the surface the catalog was read for -
  const harnessRows = new Map(); // sig → row
  if (harnessTask.result.ok) {
    const data = harnessTask.result.data;
    const ts = harnessTask.result.retrievedAt;
    if (!isPlainObject(data) || !Array.isArray(data.harnesses)) {
      pushDiag('traycer-output-malformed', 'harnesses');
    } else if (!keyHost) {
      pushDiag('traycer-host-unresolved', 'harnesses');
    } else {
      // The catalog answers for the calling context's surface: the verified
      // caller's GUI/TUI surface when known, else the CLI surface it ran on.
      const catalogSurface = callerSurface || suppliedSurface || 'cli';
      let invalid = false;
      for (const h of data.harnesses) {
        if (!isPlainObject(h) || !nonEmptyString(h.id)) { invalid = true; continue; }
        const sig = JSON.stringify([keyHost, h.id, catalogSurface]);
        harnessRows.set(sig, {
          key: { host: keyHost, harness: h.id, surface: catalogSurface },
          label: stringFact(h.label, ts),
          // A pending catalog probe is unknown availability even when the raw
          // transport boolean reads false.
          available: h.availabilityPending === true
            ? unknown('availability-pending')
            : boolFact(h.available, ts),
          availabilityPending: boolFact(h.availabilityPending, ts),
          sessionRefs: [],
        });
      }
      if (invalid) pushDiag('traycer-output-malformed', 'harnesses');
    }
  } else {
    failDiag(harnessTask.result, 'harnesses');
  }
  // Harness usage observed in the session inventory attaches sessionRefs to a
  // matching catalog row, or stands alone (catalog-absent availability).
  for (const { key, refs } of usage.values()) {
    const sig = JSON.stringify([key.host, key.harness, key.surface]);
    const existing = harnessRows.get(sig);
    if (existing) existing.sessionRefs = refs;
    else harnessRows.set(sig, { key, available: unknown('harness-catalog-absent'), sessionRefs: refs });
  }
  out.harnesses = [...harnessRows.values()];

  // --- per-harness profile catalogs ------------------------------------------
  const lastUsedReads = [];
  for (const t of profileTasks) {
    const res = t.result;
    if (!res.ok) { failDiag(res, t.scope); continue; }
    const data = res.data;
    const ts = res.retrievedAt;
    if (!isPlainObject(data) || !Array.isArray(data.profiles)) {
      pushDiag('traycer-output-malformed', t.scope);
      continue;
    }
    if (!keyHost) { pushDiag('traycer-host-unresolved', t.scope); continue; }
    const provider = nonEmptyString(data.providerId) ? data.providerId : t.harness;
    let invalid = false;
    for (const p of data.profiles) {
      const pid = isPlainObject(p) ? profileIdOf(p.selection) : null;
      if (!pid) { invalid = true; continue; }
      const row = {
        key: { host: keyHost, provider, profileId: pid },
        selection: observed(p.selection, ts),
        label: stringFact(p.label, ts),
        authStatus: stringFact(p.authStatus, ts),
        rateLimitStatus: stringFact(p.rateLimitStatus, ts),
        usageUpdatedAt: usageTimeFact(p.usageUpdatedAt),
        // Default/last-used selection only — never a session's selectedProfile.
        isEffectiveLastUsed: boolFact(p.isEffectiveLastUsed, ts),
      };
      out.profiles.push(row);
      if (p.isEffectiveLastUsed === true) {
        lastUsedReads.push({ harness: t.harness, selection: p.selection, profileId: pid, row });
      }
    }
    if (invalid) pushDiag('traycer-output-malformed', t.scope);
  }

  // Wave 2 — fresh native rate limits, last-used profiles only. Reads are
  // grouped by unique command so duplicate selections share one subprocess
  // and one scoped diagnostic; scopes are per-profile so two failed reads on
  // one harness never collide on (code, scope).
  const uniqueReads = new Map(); // JSON argv → { args, scope, rows: [] }
  for (const { harness, selection, profileId, row } of lastUsedReads) {
    const sel = selection.kind === 'ambient' ? 'ambient' : selection.profileId;
    const args = ['agent', 'profile-rate-limits', harness, '--profile', sel, '--json'];
    const sig = JSON.stringify(args);
    if (!uniqueReads.has(sig)) {
      uniqueReads.set(sig, { args, scope: `rate-limits:${harness}:${profileId}`, rows: [] });
    }
    uniqueReads.get(sig).rows.push(row);
  }
  await pooled([...uniqueReads.values()], concurrency, async ({ args, scope, rows }) => {
    const res = await invoke(args);
    if (!res.ok) { failDiag(res, scope); return; }
    const data = res.data;
    if (!isPlainObject(data)) { pushDiag('traycer-output-malformed', scope); return; }
    const usageAt = usageIso(data.usageUpdatedAt);
    for (const row of rows) {
      row.nativeRateLimits = data.rateLimits !== undefined
        ? fact(data.rateLimits, 'observed', { source: SOURCE, observedAt: usageAt })
        : unknown('traycer-field-absent');
      if (usageAt !== null) {
        row.usageUpdatedAt = fact(usageAt, 'observed', { source: SOURCE, observedAt: usageAt });
      }
    }
  });

  return out;
}

module.exports = {
  ADE_ID,
  SOURCE,
  ENV_SOURCE,
  COMMAND_TIMEOUT_MS,
  MAX_CONCURRENT,
  PROFILE_HARNESSES,
  traycerEnvCallerContext,
  parseTerminalResult,
  readTraycerRuntime,
};
