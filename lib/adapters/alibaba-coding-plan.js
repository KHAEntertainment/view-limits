'use strict';
// Alibaba Cloud Coding Plan quota, read through the official Bailian CLI.
//
// Documented interface (verified against the published docs and the CLI's own
// open-source reference on 2026-10-20):
//
//   bl usage coding-plan --output json
//
//   Introduced in bl 1.15.0 (npm package `bailian-cli`, commands bl/bailian);
//   the command reference is documented against bl 2.2.1. Alibaba publishes no
//   quota HTTP endpoint and no schema page — the console API behind the command
//   (`zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2`)
//   is private — so the CLI's own JSON stdout is the only supported
//   machine-readable surface. That is why this source is a bounded subprocess
//   and not a boundedGet.
//
// Documented JSON contract (all fields optional):
//
//   { instanceType?: string,
//     per5Hour:     { usedQuota?, totalQuota?, percentage?, resetTime? },
//     perWeek:      { … }, perBillMonth: { … } }
//
//   * resetTime is epoch MILLISECONDS.
//   * percentage exists only when used and total are present and total > 0;
//     this recipe never reads it (it is derived, and used/total is the
//     authoritative pair).
//   * `{}` means "no active Coding Plan subscription" (no VALID instance).
//   * non-numeric fields are omitted by the CLI rather than rendered.
//
// Documented plan semantics (help/en/model-studio/coding-plan): the Coding Plan
// is a cap on the number of model CALLS — 6,000 per rolling 5 hours, 45,000 per
// week, 90,000 per month, applied simultaneously, all three replenishing on
// their own schedule (5h rolls off usage from 5 hours ago each minute; weekly
// resets Monday 00:00 UTC+8; monthly resets on the renewal date). That is a
// plan quota, not credit and not a throughput header: windows are tagged
// `signal: 'quota'` and `balance` is always null.
//
// Auth: this command declares `auth: "console"`. The console access token is
// resolved ONLY from the CLI's own config file — there is no flag and no
// environment variable for it — so view-limits can neither inject nor
// legitimately hold a secret, and reading that file is out of scope. Auth is
// therefore the CLI's own approved login, established out of band by the
// operator with `bl auth login --console`. This recipe verifies that state with
// the documented, read-only, `auth:"none"` `bl auth status --output json`, whose
// output carries masked tokens only. It NEVER runs `bl auth login|logout`, never
// runs `bl config use|set` (which would mutate the active profile), and never
// passes `--console-switch-agent` (delegated-access switching). Profile
// selection uses the global `--config <name>`, which is per-invocation and does
// not change the CLI's active profile. No inference call is reachable: the
// argv head is a fixed `usage coding-plan`.
//
// Truthfulness: a window is emitted only when the CLI reported BOTH a finite
// `usedQuota` and a positive `totalQuota`; anything else is a gap in the
// evidence and is dropped rather than guessed. Exhaustion needs remaining 0 AND
// a valid future reset — with the 5h window rolling off minute by minute, a
// missing resetTime means "we do not know when it recovers", which is unknown,
// never exhausted.
//
// `ctx` seams, matching ./compat.js: `ctx.now` for the clock, `ctx.threshold`
// for the constrained cut-off, and `ctx.runBounded` for the subprocess runner
// (tests inject a stub; production never does).

const { buildStatus, isConstrained, coerceReset } = require('../normalize');
const { validateRecipeOptions, resolvedRecipeOptions } = require('../monitor-schema');
const { runBounded } = require('./bounded-exec');

const RECIPE_ID = 'alibaba-coding-plan';
// Documented console gateway regions are exemplified in the CLI flag help as
// `cn-beijing` and `ap-southeast-1`; the config field itself is a free string.
// This pattern therefore checks SHAPE only — it is the argv-safety check that
// matters — and does NOT claim to enumerate or verify supported regions. An
// unrecognised shape is refused as `unsupported-region`; a well-shaped region
// the gateway does not serve surfaces as a CLI failure, not as invented health.
const REGION_RE = /^[a-z]{2}(-[a-z0-9]+){1,3}$/;
// `bl config use --name <name>` accepts names like `default` or `token-plan`.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Exit codes published by bailian-cli-core (ExitCode).
const EXIT_AUTH = 3;
const EXIT_USAGE = 2;
const EXIT_TIMEOUT = 5;
const EXIT_NETWORK = 6;

// argv heads. Both are fixed arrays; every value that follows a flag is
// shape-validated before it is appended, so no user string can become a flag.
const QUOTA_ARGV_HEAD = Object.freeze(['usage', 'coding-plan', '--output', 'json']);
const AUTH_STATUS_ARGV = Object.freeze(['auth', 'status', '--output', 'json']);

// Documented JSON window field → normalized window type.
const WINDOWS = Object.freeze([
  Object.freeze({ key: 'per5Hour', type: 'rolling-5h' }),
  Object.freeze({ key: 'perWeek', type: 'weekly' }),
  Object.freeze({ key: 'perBillMonth', type: 'monthly' }),
]);

// Child environment allowlist. The CLI resolves its own config from HOME /
// XDG paths and its CA bundle and proxy from the usual variables; nothing else
// from this process crosses over. Values are read from process.env, never
// invented, and the env is never echoed into a status detail.
const ENV_PASSTHROUGH = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'LANG', 'LC_ALL', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
]);
const ENV_FORCED = Object.freeze({ NO_COLOR: '1', TERM: 'dumb' });

function childEnv(source) {
  const src = source && typeof source === 'object' ? source : process.env;
  const env = Object.assign({}, ENV_FORCED);
  for (const k of ENV_PASSTHROUGH) {
    const v = src[k];
    if (typeof v === 'string' && v !== '') env[k] = v;
  }
  return env;
}

function unknown(reason, extra = {}) {
  return buildStatus({
    unknown: true,
    windows: [],
    balance: null,
    resetAt: null,
    detail: Object.assign({ reason, monitorable: false }, extra),
  });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A JSON number, or a complete decimal string the CLI may serialize as such.
// `NaN`/`Infinity`/null are rejected: they are gaps in the evidence, not zeroes.
function finiteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const v = JSON.parse(trimmed);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

// Exit status → stable reason. A non-zero exit never becomes a status guess.
function exitReason(code) {
  if (code === EXIT_AUTH) return 'auth-rejected';
  if (code === EXIT_USAGE) return 'usage-error';
  if (code === EXIT_TIMEOUT) return 'cli-timeout';
  if (code === EXIT_NETWORK) return 'network-error';
  return `cli-exit-${code}`;
}

// Map a failed bounded run onto a stable reason. Child text is never included.
function runFailureReason(res) {
  if (res.error === 'cli-missing') return 'cli-missing';
  if (res.error === 'timeout') return 'cli-timeout';
  if (res.error === 'stdout-too-large') return 'cli-output-too-large';
  if (res.error) return 'cli-spawn-failed';
  if (typeof res.code === 'number' && res.code !== 0) return exitReason(res.code);
  return 'cli-failed';
}

// Read-only preflight: is a console login actually in place?
// Returns { error } or { profile } where profile is the CLI's active profile
// name, reported by `bl auth status`.
async function readAuthState(run, opts, ctx) {
  const res = await run(opts.binary, AUTH_STATUS_ARGV, {
    timeoutMs: opts.timeoutMs,
    env: childEnv(ctx.env),
  });
  if (!res.ok) return { error: runFailureReason(res) };
  const parsed = parseJson(res.stdout);
  if (!parsed) return { error: 'auth-status-malformed' };
  // `auth status` omits `console` entirely when no console login exists, and
  // reports `authenticated: false`. Either way there is no console credential.
  if (!isPlainObject(parsed.console)) return { error: 'auth-required' };
  const name = typeof parsed.config === 'string' && parsed.config ? parsed.config : null;
  return { profile: name };
}

// One documented window → a normalized window, or null when the evidence is
// incomplete. `now` gates a reset into the past.
function parseWindow(entry, type, now) {
  if (!isPlainObject(entry)) return null;
  const total = finiteNumber(entry.totalQuota);
  const used = finiteNumber(entry.usedQuota);
  // The CLI documents `percentage` as absent when there is no positive total;
  // without both numbers there is no remaining count to report.
  if (total === null || used === null || total <= 0) return null;
  // More used than the cap is contradictory evidence about the pool. Clamping
  // would invent remaining capacity, so the whole read is refused instead.
  if (used < 0 || used > total) return { error: 'contradictory-quota' };
  const resetMs = finiteNumber(entry.resetTime);
  const resetAt = resetMs === null ? null : coerceReset(resetMs);
  // A reset in the past is not a recovery time.
  const usableReset = resetAt && Date.parse(resetAt) > now ? resetAt : null;
  return { window: { type, remaining: total - used, limit: total, resetAt: usableReset } };
}

function parseQuotaPayload(payload, now) {
  if (!isPlainObject(payload)) return { error: 'malformed-output' };
  const instanceType = typeof payload.instanceType === 'string' && payload.instanceType
    ? payload.instanceType : null;
  // Documented: `{}` is emitted when no VALID instance exists.
  const declared = WINDOWS.some((w) => Object.prototype.hasOwnProperty.call(payload, w.key));
  if (!declared && instanceType === null) return { error: 'no-active-subscription' };
  const windows = [];
  for (const spec of WINDOWS) {
    const parsed = parseWindow(payload[spec.key], spec.type, now);
    if (parsed && parsed.error) return { error: parsed.error };
    if (parsed && parsed.window) windows.push(Object.assign({}, parsed.window, { signal: 'quota' }));
  }
  if (!windows.length) return { error: 'no-quota-data' };
  return { windows, instanceType };
}

async function fetchStatus(cfg, token, ctx = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  // The recipe holds no credential and is never handed one to forward.
  const base = { recipe: RECIPE_ID, signal: 'quota' };

  const check = validateRecipeOptions(RECIPE_ID, c.recipeOptions || {});
  if (!check.ok) return unknown(check.code || 'invalid-recipe-options', base);
  const opts = resolvedRecipeOptions(RECIPE_ID, c.recipeOptions);

  // `region` binds the reading to a console gateway. It is a declaration, not
  // an observation: the CLI's JSON payload echoes no region, so
  // `regionVerified` stays false and the status never implies the gateway was
  // confirmed.
  if (!c.region) return unknown('region-required', base);
  if (typeof c.region !== 'string' || !REGION_RE.test(c.region)) {
    return unknown('unsupported-region', Object.assign({}, base, { region: null }));
  }
  let profile = null;
  if (c.profile !== undefined && c.profile !== null && c.profile !== '') {
    if (typeof c.profile !== 'string' || !PROFILE_RE.test(c.profile)) {
      return unknown('profile-invalid', Object.assign({}, base, { region: c.region }));
    }
    profile = c.profile;
  }

  const now = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const run = typeof ctx.runBounded === 'function' ? ctx.runBounded : runBounded;
  const detail = Object.assign({}, base, {
    region: c.region,
    regionVerified: false,
    regionSource: 'route-declaration',
    site: opts.site,
  });

  const auth = await readAuthState(run, opts, ctx);
  if (auth.error) {
    if (auth.error === 'auth-required' || auth.error === 'auth-rejected') {
      return unknown(auth.error, Object.assign({}, detail, {
        note: 'run: bl auth login --console (the CLI owns its console credential; view-limits stores none)',
      }));
    }
    if (auth.error === 'cli-missing') {
      return unknown('cli-missing', Object.assign({}, detail, {
        note: 'install the Bailian CLI (npm i -g bailian-cli) and put `bl` on PATH',
      }));
    }
    return unknown(auth.error, detail);
  }

  const argv = QUOTA_ARGV_HEAD.slice();
  // `--config` is per-invocation; it never changes the CLI's active profile.
  if (profile) argv.push('--config', profile);
  argv.push('--console-region', c.region, '--console-site', opts.site);

  const res = await run(opts.binary, argv, {
    timeoutMs: opts.timeoutMs,
    env: childEnv(ctx.env),
  });
  const usedProfile = profile || auth.profile || null;
  const finalDetail = Object.assign({}, detail, { profile: usedProfile });
  if (!res.ok) {
    const reason = runFailureReason(res);
    const extra = { cliExitCode: typeof res.code === 'number' ? res.code : null };
    if (reason === 'auth-rejected') {
      return unknown(reason, Object.assign({}, finalDetail, extra, {
        note: 'the CLI rejected its console credential; re-run: bl auth login --console',
      }));
    }
    if (reason === 'no-active-subscription' || reason === 'contradictory-quota') return unknown(reason, finalDetail);
    return unknown(reason, Object.assign({}, finalDetail, extra));
  }

  const payload = parseJson(res.stdout);
  if (!payload) {
    return unknown('malformed-output', Object.assign({}, finalDetail, {
      note: 'the CLI did not emit a JSON object on stdout',
    }));
  }
  const parsed = parseQuotaPayload(payload, now);
  if (parsed.error) return unknown(parsed.error, finalDetail);

  const windows = parsed.windows;
  const withPlan = Object.assign({}, finalDetail);
  if (parsed.instanceType) withPlan.instanceType = parsed.instanceType;

  const drained = windows.filter((w) => w.remaining === 0);
  if (drained.length) {
    const resets = drained.map((w) => (w.resetAt ? Date.parse(w.resetAt) : NaN));
    if (resets.some((t) => !Number.isFinite(t) || t <= now)) {
      return unknown('exhaustion-without-recovery', Object.assign({}, withPlan, { windows }));
    }
    // Recovery is when the LAST drained window resets; a deny-eligible cache
    // entry must expire by then (bin/vl.js entryFor bounds freshUntil).
    const recoveryAt = new Date(Math.max(...resets)).toISOString();
    return buildStatus({
      exhausted: true,
      windows,
      balance: null,
      resetAt: recoveryAt,
      detail: Object.assign({}, withPlan, { monitorable: true, recoveryAt }),
    });
  }
  const threshold = Number.isFinite(ctx.threshold) ? ctx.threshold : 0.2;
  return buildStatus({
    constrained: isConstrained(windows, threshold),
    windows,
    balance: null,
    detail: Object.assign({}, withPlan, { monitorable: true }),
  });
}

module.exports = { fetchStatus, RECIPE_ID, REGION_RE, PROFILE_RE, QUOTA_ARGV_HEAD, AUTH_STATUS_ARGV, parseQuotaPayload };