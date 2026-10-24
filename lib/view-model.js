'use strict';
// Transport-neutral normalized runtime-inventory view model.
//
// buildViewModel(snapshot, updatedAt) renders a runtime snapshot produced by
// lib/runtime-snapshot.js into a single normalized JS object every
// presentation surface consumes:
//   - Text (bin/vl.js report) consumes the pre-formatted `lines` array and
//     joins it with '\n'; the resulting string is byte-identical to the prior
//     inline renderer in bin/vl.js.
//   - Future JSON / HTML consumers (Phase 3-4 dashboard) consume the
//     structured sections (`requester`, `harnessPool`, `routes`, `counts`,
//     `diagnostics`).
//
// Hard constraints:
//   - Pure function: no I/O, no process / fs / network / subprocess.
//   - No Claude hook APIs (no stdin parsing, no JSON stdout for the gate).
//   - No terminal codes, no ANSI, no HTML — those belong in their respective
//     consumers that read the structured sections.
//   - Mirrors the prior bin/vl.js rendering: field order, quoting, " · "
//     separators, indentation ("  ", "    "), "<0.01" sub-cent boundary,
//     Math.round((remaining/limit)*100) for windowed percentages, xiaomi note
//     selection rules, and the stale / binding / model suffixes all carry
//     forward unchanged so text output stays byte-identical.

const VIEW_MODEL_SCHEMA_VERSION = 1;

// Issue #59 — the versioned VIEW schema. `schemaVersion` here is the version
// of the shared view schema (the JSON contract the dashboard and any headless
// consumer read). It is deliberately its own number from
// VIEW_MODEL_SCHEMA_VERSION, which versions the report's runtime-inventory
// view model.
const VIEW_SCHEMA_VERSION = 1;

// Xiaomi provider marker + dashboard URL. Mirrors lib/xiaomi-session.js's
// XIAOMI_PROVIDER and DASHBOARD_URL constants; duplicated here as plain
// literals so the view model never pulls the live adapter / cookie / metadata
// modules. Update both if either changes upstream.
const XIAOMI_PROVIDER = 'xiaomi';
const XIAOMI_DASHBOARD_URL = 'https://platform.xiaomimimo.com/';

const { basisOf } = require('./normalize');
const { decide: gateDecide } = require('./gate');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---- text-boundary escaping (#88) --------------------------------------------
//
// Provider-supplied strings reach the route line verbatim: a provider error, a
// state reason, a reauth profile or URL, a binding name. A newline inside one
// of them would fabricate a second route line, and a terminal control
// character would rewrite the screen. So the TEXT boundary escapes control
// characters.
//
// Only control characters are escaped. Every other character — quotes and
// backslashes included — is left alone, so a value that carries no control
// character renders byte-identically to the pre-#88 output (#88 AC3). The
// structured JSON keeps the ORIGINAL value: escaping there would corrupt the
// reported fact, and JSON.stringify escapes at the document boundary anyway.
//
// (#80 shipped a JSON.stringify-based escape for `currentPeriodEnd`. That
// path is left exactly as it is — it is shipped, pinned behavior — so the two
// escapes deliberately differ: one escapes quotes, this one does not.)
function escapeControlChars(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x08) { out += '\\b'; continue; }
    if (code === 0x09) { out += '\\t'; continue; }
    if (code === 0x0a) { out += '\\n'; continue; }
    if (code === 0x0c) { out += '\\f'; continue; }
    if (code === 0x0d) { out += '\\r'; continue; }
    if (code < 0x20 || code === 0x7f) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += ch;
  }
  return out;
}

// The 80-character cap the non-Xiaomi error branch has always used. Applied
// to the RAW text (before escaping) so the cap measures what the provider
// said, not the escaped form.
function capText(value, limit = 80) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ---- fact helpers ------------------------------------------------------------

function factValue(f) {
  return isPlainObject(f) && f.provenance !== 'unknown' && f.value !== null && f.value !== undefined
    ? f.value : null;
}

function factText(f) {
  const v = factValue(f);
  return v === null ? 'unknown' : String(v);
}

// ---- money / number formatting ----------------------------------------------

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value, currency) {
  const amount = finiteNumber(value);
  if (amount == null) return null;
  const unit = typeof currency === 'string' && currency.trim() ? ` ${currency.trim()}` : '';
  if (amount > 0 && amount < 0.01) return `<0.01${unit}`;
  if (amount < 0 && amount > -0.01) return `${amount.toPrecision(2)}${unit}`;
  return `${amount.toFixed(2)}${unit}`;
}

// ---- route filter -----------------------------------------------------------

// An unconfigured (cache-orphan) row renders only when it carries some known
// evidence; a malformed or empty orphan reproduces the v1 behavior of
// dropping non-object cache entries from the human report.
function renderableRoute(row) {
  if (!isPlainObject(row)) return false;
  if (row.configured) return true;
  const r = row.resource || {};
  return factValue(r.state) !== null || factValue(r.observedAt) !== null ||
    factValue(r.source) !== null || (Array.isArray(r.windows) && r.windows.length > 0) ||
    r.balance != null || r.usage != null;
}

// ---- xiaomi reauth note ------------------------------------------------------

function reauthNote(reauth) {
  // #88 — the profile and the URL are provider/session supplied: escape them
  // so neither can fabricate a line or a terminal control sequence. Values
  // without control characters render byte-identically.
  const profile = reauth && reauth.profile ? ` (profile ${escapeControlChars(reauth.profile)})` : '';
  const url = reauth && reauth.url ? escapeControlChars(reauth.url) : XIAOMI_DASHBOARD_URL;
  return `session unavailable — open ${url} in Chrome${profile} and log in if needed; next refresh checks for new cookies`;
}

// ---- harness / session / profile text ---------------------------------------

function renderHarnessText(h) {
  const key = isPlainObject(h.key) ? h.key : {};
  const avail = factValue(h.available);
  const availability = avail === true ? 'available'
    : avail === false ? 'unavailable'
    : `availability unknown${h.available && h.available.reason ? ` — ${h.available.reason}` : ''}`;
  const refs = Array.isArray(h.sessionRefs) ? h.sessionRefs.length : 0;
  const resources = Array.isArray(h.resourceRefs) ? h.resourceRefs.length : 0;
  const defaults = isPlainObject(h.defaults)
    ? Object.entries(h.defaults).map(([k, f]) => `${k}=${factText(f)}`).join(' ')
    : '';
  return `    ${key.harness || 'unknown'} (${key.surface || 'unknown'}) @ ${key.host || 'unknown'}: ${availability}` +
    `${refs ? ` · ${refs} session(s)` : ''}${resources ? ` · ${resources} resource ref(s)` : ''}` +
    `${defaults ? ` · defaults: ${defaults}` : ''}`;
}

function renderSessionText(s) {
  const key = isPlainObject(s.key) ? s.key : {};
  const bits = [];
  if (factValue(s.harness) !== null) bits.push(`harness ${factValue(s.harness)}`);
  if (factValue(s.surface) !== null) bits.push(factValue(s.surface));
  if (factValue(s.title) !== null) bits.push(`"${factValue(s.title)}"`);
  const active = factValue(s.active);
  if (active !== null) bits.push(active ? 'active' : 'idle');
  if (factValue(s.isSelf) === true) bits.push('this requester');
  return `    session ${key.agentId || 'unknown'} @ ${key.host || 'unknown'}: ${bits.join(' · ') || 'no facts'}`;
}

function renderProfileText(p) {
  const key = isPlainObject(p.key) ? p.key : {};
  const bits = [];
  if (factValue(p.authStatus) !== null) bits.push(`auth ${factValue(p.authStatus)}`);
  if (factValue(p.rateLimitStatus) !== null) bits.push(`rate limits ${factValue(p.rateLimitStatus)}`);
  const usageAt = factValue(p.usageUpdatedAt);
  bits.push(usageAt ? `usage observed ${usageAt}` : 'usage unobserved');
  if (factValue(p.nativeRateLimits) !== null) bits.push('native rate limits observed');
  return `    profile ${key.provider || 'unknown'}/${key.profileId || 'unknown'} @ ${key.host || 'unknown'}: ${bits.join(' · ')}`;
}

// ---- route text + structured row --------------------------------------------

function quotaText(res) {
  const balance = isPlainObject(res.balance) ? res.balance : null;
  const formattedBalance = balance ? formatMoney(balance.available, balance.currency) : null;
  if (formattedBalance) {
    let line = `balance ${formattedBalance}`;
    if (isPlainObject(balance.spent)) {
      const spentParts = [];
      const daily = formatMoney(balance.spent.daily, balance.currency);
      const weekly = formatMoney(balance.spent.weekly, balance.currency);
      if (daily) spentParts.push(`${daily} today`);
      if (weekly) spentParts.push(`${weekly} week`);
      if (spentParts.length) line += ` · spent ${spentParts.join(' / ')}`;
    }
    if (isPlainObject(balance.limit)) {
      const cap = formatMoney(balance.limit.amount, balance.currency);
      if (cap) line += ` · ${cap} ${balance.limit.period || balance.limit.reset || 'period'} cap`;
    }
    return line;
  }
  if (isPlainObject(res.usage)) {
    const usage = res.usage;
    const spentParts = [];
    const daily = formatMoney(usage.daily, usage.currency);
    const weekly = formatMoney(usage.weekly, usage.currency);
    const monthly = formatMoney(usage.monthly, usage.currency);
    if (daily) spentParts.push(`${daily} today`);
    if (weekly) spentParts.push(`${weekly} week`);
    if (monthly) spentParts.push(`${monthly} month`);
    if (spentParts.length) return `spent ${spentParts.join(' / ')}`;
  }
  if (Array.isArray(res.windows) && res.windows.length) {
    return res.windows.map((w) => {
      if (w.limit > 0 && w.remaining != null) return `${w.type} ${Math.round((w.remaining / w.limit) * 100)}%`;
      return `${w.type} ${w.remaining}/${w.limit}`;
    }).join(' · ');
  }
  return null;
}

function noteText(row, res) {
  const state = factValue(res.state) || 'unknown';
  if (state !== 'unknown') return '';
  const xiaomiRow = factValue(row.provider) === XIAOMI_PROVIDER;
  if (xiaomiRow) {
    if (res.reauth) return ` — ${reauthNote(res.reauth)}`;
    // #88 — the Xiaomi error branch now carries the same 80-character cap as
    // the non-Xiaomi branch below (it was the one uncapped path), and control
    // characters are escaped so an error text can never fabricate a line.
    if (res.error) return ` — ${escapeControlChars(capText(res.error))}`;
    if (res.state && res.state.reason) return ` — ${escapeControlChars(res.state.reason)}`;
    return '';
  }
  if (res.error) {
    // #88 — the cap still measures the raw provider text (unchanged), and the
    // escaped result is byte-identical for a value without control chars.
    const tail = escapeControlChars(capText(res.error));
    return ` — ${tail} (rotate via /view-limits:update ${row.id})`;
  }
  if (res.state && res.state.reason) return ` — ${escapeControlChars(res.state.reason)}`;
  return '';
}

// #80 — human label for an adapter-declared measurement basis. The suffix is
// rendered only when a status carries an EXPLICIT basis, so every route whose
// adapter does not declare one stays byte-identical to the #35 rendering.
const BASIS_LABELS = {
  'quota-window': 'quota window',
  'token-count': 'token count',
  balance: 'balance',
  // #80 CodeRabbit finding — an EXPLICIT `none` basis must still be labeled:
  // a windowless status explicitly declaring `none` renders its suffix even
  // though it has no quota text.
  none: 'none',
};

function renderRouteText(row) {
  const res = isPlainObject(row.resource) ? row.resource : {};
  const state = factValue(res.state) || 'unknown';
  const quota = quotaText(res);
  const basisValue = factValue(res.basis);
  const basisLabel = typeof basisValue === 'string' ? BASIS_LABELS[basisValue] : null;
  // The basis suffix renders independently of quota availability: quota text
  // stays conditional on quota being present, but an explicit basis label
  // must never be dropped for lack of a window.
  const basis = basisLabel ? ` (${basisLabel})` : '';
  // #80 — a reported plan period end is disclosed, never a reset: it renders
  // with a `(reported)` marker and is never fed into resetAt.
  const periodEnd = factValue(res.periodEnd);
  // CodeRabbit finding (#80 batch) — escape control characters in TEXT only:
  // a provider-supplied currentPeriodEnd containing e.g. a newline must never
  // fabricate a second route line. Structured JSON still carries the original
  // value (JSON.stringify escapes at the document boundary; the parsed value
  // is unchanged), so the disclosed value is never corrupted for machine
  // consumers.
  const period = periodEnd
    ? ` · plan period ends ${JSON.stringify(String(periodEnd)).slice(1, -1)} (reported)`
    : '';
  const resetAt = factValue(res.resetAt);
  const reset = resetAt ? ` · resets ${new Date(resetAt).toLocaleString()}` : '';
  const note = noteText(row, res);
  const stale = res.freshness === 'stale' ? ' (stale)' : '';
  // #88 — the binding names come from a harness/host identity: escape them so
  // a newline in one cannot fabricate a route line.
  const binding = Array.isArray(row.boundBy) && row.boundBy.length
    ? ` · bound to ${row.boundBy.map((b) => `${escapeControlChars(b.harness)}@${escapeControlChars(b.host)}`).join(', ')}`
    : '';
  const modelsValue = factValue(row.models);
  const models = Array.isArray(modelsValue) && modelsValue.length
    ? ` · models ${modelsValue.join(', ')}`
    : '';
  return `    ${row.id}: ${state}${quota ? ' · ' + quota : ''}${basis}${period}${reset}${note}${binding}${models}${stale}`;
}

// ---- structured row serializers (for non-text consumers) --------------------

function serializeHarness(h) {
  const key = isPlainObject(h.key) ? h.key : {};
  const avail = factValue(h.available);
  let availability = 'unknown';
  let availabilityReason = null;
  if (avail === true) availability = 'available';
  else if (avail === false) availability = 'unavailable';
  else if (h.available && h.available.reason) availabilityReason = h.available.reason;
  return {
    harness: key.harness || null,
    surface: key.surface || null,
    host: key.host || null,
    availability,
    availabilityReason,
    sessionCount: Array.isArray(h.sessionRefs) ? h.sessionRefs.length : 0,
    resourceCount: Array.isArray(h.resourceRefs) ? h.resourceRefs.length : 0,
    defaults: isPlainObject(h.defaults)
      ? Object.fromEntries(Object.entries(h.defaults).map(([k, v]) => [k, factText(v)]))
      : {},
    line: renderHarnessText(h),
  };
}

function serializeSession(s) {
  const key = isPlainObject(s.key) ? s.key : {};
  return {
    agentId: key.agentId || null,
    host: key.host || null,
    harness: factValue(s.harness),
    surface: factValue(s.surface),
    title: factValue(s.title),
    active: factValue(s.active),
    isSelf: factValue(s.isSelf) === true,
    line: renderSessionText(s),
  };
}

function serializeProfile(p) {
  const key = isPlainObject(p.key) ? p.key : {};
  const usageAt = factValue(p.usageUpdatedAt);
  return {
    provider: key.provider || null,
    profileId: key.profileId || null,
    host: key.host || null,
    authStatus: factValue(p.authStatus),
    rateLimitStatus: factValue(p.rateLimitStatus),
    usageObserved: usageAt !== null,
    usageAt,
    nativeRateLimits: factValue(p.nativeRateLimits) !== null,
    line: renderProfileText(p),
  };
}

function serializeRoute(row) {
  const res = isPlainObject(row.resource) ? row.resource : {};
  const state = factValue(res.state) || 'unknown';
  const binding = Array.isArray(row.boundBy) ? row.boundBy : [];
  const modelsValue = factValue(row.models);
  return {
    id: row.id,
    configured: !!row.configured,
    provider: factValue(row.provider),
    state,
    line: renderRouteText(row),
    binding: binding.map((b) => ({ harness: b.harness, host: b.host, surface: b.surface || null })),
    models: Array.isArray(modelsValue) ? modelsValue.slice() : null,
    stale: res.freshness === 'stale',
    freshness: res.freshness || 'unknown',
    // #80 — additive measurement diagnostics.
    basis: factValue(res.basis),
    periodEnd: factValue(res.periodEnd),
    resetAt: factValue(res.resetAt),
    freshUntil: factValue(res.freshUntil),
    observedAt: factValue(res.observedAt),
  };
}

// ---- main builder -----------------------------------------------------------

function buildViewModel(snapshot, updatedAt) {
  const snap = isPlainObject(snapshot) ? snapshot : {};

  // Requester — the assembled caller facts, verbatim.
  const c = isPlainObject(snap.caller) ? snap.caller : {};
  const ade = factValue(c.ade);
  const agentId = factValue(c.agentId);
  const epicId = factValue(c.epicId);
  const who = [
    ade,
    agentId != null ? `agent ${agentId}` : null,
    epicId != null ? `epic ${epicId}` : null,
  ].filter(Boolean).join(' · ');
  const harness = factValue(c.harness);
  const surface = factValue(c.surface);
  const host = factValue(c.host);
  const where = [harness, surface, host].filter(Boolean).join(' · ');
  const differsFromDefault = factValue(c.differsFromDefault) === true;
  const modelsLine = `    models: configured ${factText(c.configuredModel)} · default ${factText(c.defaultModel)} · effective ${factText(c.effectiveModel)}${differsFromDefault ? ' (differs from default)' : ''}`;

  const selProfile = factValue(c.selectedProfile);
  const selAccount = factValue(c.selectedAccount);
  const selectionPresent = selProfile !== null || selAccount !== null;
  const selectionLine = selectionPresent
    ? `    selection: profile ${factText(c.selectedProfile)} · account ${factText(c.selectedAccount)}`
    : null;

  // Harness pool — harnesses, sessions and native profiles stay separate
  // sections keyed by their own composite identity.
  const harnesses = Array.isArray(snap.harnesses) ? snap.harnesses : [];
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  const profiles = Array.isArray(snap.profiles) ? snap.profiles : [];
  const poolReason = Array.isArray(snap.diagnostics)
    ? snap.diagnostics.find((d) => isPlainObject(d) && d.code === 'runtime-pool-cache-empty')
    : null;
  const harnessLines = harnesses.map(renderHarnessText);
  const sessionLines = sessions.map(renderSessionText);
  const profileLines = profiles.map(renderProfileText);
  const poolLines = [...harnessLines, ...sessionLines, ...profileLines];
  const poolEmpty = poolLines.length === 0;
  const poolReasonLine = poolReason ? `    reason: ${poolReason.summary}` : null;

  // External provider routes — one row per renderable route, sorted by id.
  const allRoutes = Array.isArray(snap.routes) ? snap.routes : [];
  const rows = allRoutes.filter(renderableRoute)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const routeLines = rows.map(renderRouteText);

  // Counts — exactly the surfaces of the prior inline renderer.
  const out = { healthy: 0, constrained: 0, exhausted: 0, unavailable: 0, unknown: 0 };
  let staleCount = 0;
  for (const row of rows) {
    const s = factValue(row.resource && row.resource.state) || 'unknown';
    out[s] = (out[s] || 0) + 1;
    if (row.resource && row.resource.freshness === 'stale') staleCount += 1;
  }
  const countParts = [`${out.healthy} healthy`, `${out.constrained} constrained`, `${out.exhausted} exhausted`];
  if (out.unavailable) countParts.push(`${out.unavailable} unavailable`);
  countParts.push(`${out.unknown} unknown`);
  if (staleCount) countParts.push(`${staleCount} stale`);
  const countsLine = countParts.join(' · ');

  const unobserved = allRoutes
    .filter((r) => r && r.configured && r.resource && r.resource.state && r.resource.state.reason === 'no-cached-observation')
    .length;
  const unobservedLine = unobserved
    ? `  ${unobserved} configured route(s) have no cached observation — /view-limits refreshes routes with stored keys and provider config (/view-limits:setup)`
    : null;

  const diagnostics = Array.isArray(snap.diagnostics) ? snap.diagnostics : [];
  const nonPoolDiagnostics = diagnostics.filter((d) => d !== poolReason);
  const diagnosticLines = nonPoolDiagnostics.map((d) => `  notice [${d.scope || 'snapshot'}] ${d.code} — ${d.summary}`);

  // Compose final text lines in the same order as the prior renderer.
  const lines = [];
  lines.push(`view-limits runtime inventory — generated ${snap.generatedAt} · completeness ${snap.completeness}`);
  lines.push(`  requester: ${who || 'unknown'}${where ? ` — ${where}` : ''}`);
  lines.push(modelsLine);
  if (selectionLine) lines.push(selectionLine);

  lines.push('  harness pool:');
  if (poolEmpty) {
    lines.push('    (no runtime harness/session/profile facts)');
    if (poolReasonLine) lines.push(poolReasonLine);
  } else {
    for (const l of poolLines) lines.push(l);
  }

  lines.push('  external routes:');
  if (rows.length === 0) lines.push('    (no configured routes)');
  else for (const l of routeLines) lines.push(l);

  lines.push('');
  lines.push(`  ${countsLine}`);
  if (unobservedLine) lines.push(unobservedLine);
  for (const l of diagnosticLines) lines.push(l);
  lines.push(`  cache updated ${updatedAt || 'never'}`);

  return {
    schemaVersion: VIEW_MODEL_SCHEMA_VERSION,
    generatedAt: snap.generatedAt || null,
    completeness: snap.completeness || null,
    cacheUpdatedAt: updatedAt || null,

    requester: {
      ade,
      agentId,
      epicId,
      who,
      harness,
      surface,
      host,
      where,
      models: {
        configured: factValue(c.configuredModel),
        default: factValue(c.defaultModel),
        effective: factValue(c.effectiveModel),
        differsFromDefault,
        line: modelsLine,
      },
      selection: {
        profile: selProfile,
        account: selAccount,
        present: selectionPresent,
        line: selectionLine,
      },
    },

    harnessPool: {
      harnesses: harnesses.map(serializeHarness),
      sessions: sessions.map(serializeSession),
      profiles: profiles.map(serializeProfile),
      poolReason: poolReason
        ? { code: poolReason.code, scope: poolReason.scope || null, summary: poolReason.summary }
        : null,
      empty: poolEmpty,
      reasonLine: poolReasonLine,
      lines: poolLines,
    },

    routes: rows.map(serializeRoute),

    counts: { ...out },
    staleCount,
    countsLine,
    unobservedCount: unobserved,
    unobservedLine,

    diagnostics: nonPoolDiagnostics.map((d) => ({
      code: d.code, scope: d.scope || null, summary: d.summary,
    })),
    diagnosticLines,

    lines,
  };
}

// ---- versioned view schema (Issue #59) --------------------------------------
//
// buildViewSchema(snapshot, opts) turns the runtime snapshot into ONE
// normalized object that BOTH the text renderers and the JSON consumer read.
// The text never re-derives a fact the schema does not carry, so the two
// surfaces can never disagree (Issue #59 AC1).
//
// Truthfulness rules this builder keeps:
//   * a fact that is not observed is null — never zero, false or healthy
//   * a window that reports only a percent keeps remaining/limit null
//   * balance is never inferred from windows
//   * the cached `status.state` is the ONLY state source: the view never
//     derives a state from a measurement, so a route the adapter called
//     unknown stays unknown whatever its counts say
//   * a route whose freshness is not 'fresh' is serialized as unknown with
//     reasonCode 'stale-observation' — stale is never healthy
//   * the quota eligibility is the GATE's own decision (read-only use of
//     lib/gate.js), so the view and the gate can never disagree

// Provider display names for the text surfaces. The route id stays the stable
// identity in the structured schema; an unknown provider falls back to it.
const PROVIDER_NAMES = Object.freeze({
  minimax: 'MiniMax',
  kimi: 'Kimi',
  glm: 'Z.ai / GLM',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  xiaomi: 'Xiaomi MiMo',
});

// The text label for one quota window.
const WINDOW_LABELS = Object.freeze({
  'rolling-5h': '5-hour',
  weekly: 'Weekly',
  monthly: 'Monthly',
  credit: 'Quota',
  concurrency: 'Concurrency',
  tokens: 'Tokens',
});

// The basis label rendered next to a measurement. It renders only for an
// EXPLICIT, adapter-declared basis — the rule #80 established — so a route
// whose adapter declares no basis stays byte-identical.
const BASIS_TEXT = Object.freeze({
  'quota-window': 'quota window',
  'token-count': 'token count',
  balance: 'balance',
  none: 'none',
});

// The allowlisted diagnostic codes the view may report. An unbounded code
// list is a leak, so anything not on this list is dropped rather than shown.
const VIEW_REASON_CODES = Object.freeze([
  'no-cached-observation', 'cached-state-absent', 'cached-field-absent',
  'stale-observation', 'config-revision-obsolete', 'state-unknown',
  'no-fresh-observation', 'fresh-exhausted', 'window-unit-unavailable',
  'reauth-required', 'reauth-url-invalid', 'no-routes-configured',
  'no-observed-state', 'config-inconclusive', 'config-corrupt',
  'migration-pending',
]);

const BAR_WIDTH = 20;

// The gate's own decision, asked with a fixed deny-mode gate config so the
// answer is the gate's RULE (fresh + unobsolete + exhausted -> deny) and not
// a function of the user's configured gate mode.
const GATE_PROBE_CONFIG = Object.freeze({ gate: { mode: 'deny', injectContext: false } });

function numericOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function allowReasonCodes(codes) {
  const out = [];
  for (const c of Array.isArray(codes) ? codes : []) {
    if (typeof c !== 'string' || !VIEW_REASON_CODES.includes(c)) continue;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// A reauth URL is structured data, never text parsed out of a provider body.
// It is validated before it is displayed: https only, no userinfo, and no
// query string (a query can carry a session token). A URL that fails becomes
// null plus a reason code — never a partially trusted link.
function validateReauthUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { value: null, reasonCodes: ['reauth-url-invalid'] };
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { value: null, reasonCodes: ['reauth-url-invalid'] };
  }
  if (parsed.protocol !== 'https:') return { value: null, reasonCodes: ['reauth-url-invalid'] };
  if (parsed.username || parsed.password) return { value: null, reasonCodes: ['reauth-url-invalid'] };
  if (parsed.search) return { value: null, reasonCodes: ['reauth-url-invalid'] };
  return { value: raw.trim(), reasonCodes: [] };
}

function windowUnitFor(w, basis) {
  if (typeof w.unit === 'string' && w.unit) return w.unit;
  // `token-count` IS the definition of a token measurement, so the unit is
  // known there. Any other basis leaves the unit unknown rather than
  // guessing "requests".
  if (basis === 'token-count') return 'tokens';
  return null;
}

function buildWindows(rawWindows, basis) {
  if (!Array.isArray(rawWindows)) return [];
  const out = [];
  for (const w of rawWindows) {
    if (!isPlainObject(w)) continue;
    const remaining = numericOrNull(w.remaining);
    const limit = numericOrNull(w.limit);
    let ratio = null;
    if (remaining !== null && limit !== null && limit > 0) {
      ratio = remaining / limit;
    } else if (typeof w.remainingRatio === 'number' && Number.isFinite(w.remainingRatio)) {
      ratio = w.remainingRatio;
    } else if (typeof w.percent === 'number' && Number.isFinite(w.percent)) {
      ratio = w.percent / 100;
    }
    out.push({
      type: typeof w.type === 'string' && w.type ? w.type : null,
      unit: windowUnitFor(w, basis),
      remaining,
      limit,
      remainingRatio: ratio === null ? null : ratio,
      resetAt: typeof w.resetAt === 'string' && w.resetAt ? w.resetAt : null,
    });
  }
  return out;
}

function buildBalance(raw) {
  if (!isPlainObject(raw)) return null;
  const amount = numericOrNull(raw.available);
  // A balance with no amount is no balance: the gate's safeBalance drops it
  // too, and a null amount must never render as 0.00.
  if (amount === null) return null;
  const spent = isPlainObject(raw.spent)
    ? {
      daily: numericOrNull(raw.spent.daily),
      weekly: numericOrNull(raw.spent.weekly),
      monthly: numericOrNull(raw.spent.monthly),
    }
    : null;
  const hasSpent = spent && (spent.daily !== null || spent.weekly !== null || spent.monthly !== null);
  return {
    amount,
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : null,
    spent: hasSpent ? spent : null,
  };
}

function buildReauth(raw) {
  if (!isPlainObject(raw)) return null;
  const url = validateReauthUrl(raw.url);
  return {
    required: true,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
    url: url.value,
    profile: typeof raw.profile === 'string' && raw.profile ? raw.profile : null,
    reasonCodes: url.reasonCodes,
  };
}

// The gate's verdict on one route. `current` is true only when the gate would
// act on the cached entry: fresh AND not superseded by a config change.
function gateVerdict(gate, routeId) {
  if (!isPlainObject(gate)) return { available: false, current: null };
  const entries = isPlainObject(gate.entries) ? gate.entries : {};
  const routes = isPlainObject(gate.routes) ? gate.routes : {};
  const route = routes[routeId];
  if (!isPlainObject(route)) return { available: false, current: null };
  const entry = isPlainObject(entries[routeId]) ? entries[routeId] : undefined;
  const now = typeof gate.now === 'number' ? gate.now : Date.now();
  const decision = gateDecide({ route, entry, now, config: GATE_PROBE_CONFIG });
  return { available: true, current: decision.refresh !== true, denied: decision.action === 'deny' };
}

function buildRouteSchema(row, ctx) {
  const res = isPlainObject(row.resource) ? row.resource : {};
  const provider = factValue(row.provider);
  const account = factValue(row.account);
  const pool = factValue(row.pool);

  const stateFact = isPlainObject(res.state) ? res.state : null;
  const rawState = factValue(res.state) || 'unknown';
  const stateReason = stateFact && typeof stateFact.reason === 'string' ? stateFact.reason : null;
  const snapshotFreshness = res.freshness === 'fresh' || res.freshness === 'stale' ? res.freshness : 'unknown';

  // The basis: an EXPLICIT adapter-declared basis wins; otherwise it is
  // derived from the evidence the route carries (lib/normalize.js#basisOf).
  const declaredBasis = factValue(res.basis);
  const basis = declaredBasis || basisOf({ windows: res.windows, balance: res.balance });

  const windows = buildWindows(res.windows, basis);
  const balance = buildBalance(res.balance);
  const reauth = buildReauth(res.reauth);

  const verdict = gateVerdict(ctx.gate, row.id);
  const fresh = verdict.available ? verdict.current === true : snapshotFreshness === 'fresh';

  // Stale is never healthy: a route whose observation is not fresh is
  // serialized as unknown, and the last-known facts stay visible.
  const state = fresh ? rawState : 'unknown';
  const freshness = fresh ? 'fresh' : (snapshotFreshness === 'stale' ? 'stale' : 'unknown');

  const reasonCodes = [];
  if (!fresh) {
    if (snapshotFreshness === 'stale') reasonCodes.push('stale-observation');
    else if (verdict.available && snapshotFreshness === 'fresh') reasonCodes.push('config-revision-obsolete');
    else reasonCodes.push('no-fresh-observation');
  }
  if (state === 'unknown' && stateReason) reasonCodes.push(stateReason);
  if (windows.some((w) => w.unit === null)) reasonCodes.push('window-unit-unavailable');
  if (reauth) {
    reasonCodes.push('reauth-required');
    for (const c of reauth.reasonCodes) reasonCodes.push(c);
  }

  // The quota eligibility IS the gate's rule: a fresh, unobsolete entry that
  // the gate would act on. Nothing else may promote a route to 'eligible'.
  let quotaEligibility = 'unresolved';
  if (fresh) {
    if (rawState === 'exhausted') {
      quotaEligibility = 'ineligible';
      reasonCodes.push('fresh-exhausted');
    } else if (rawState === 'healthy' || rawState === 'constrained') {
      quotaEligibility = 'eligible';
    } else {
      reasonCodes.push('state-unknown');
    }
  }

  return {
    id: String(row.id),
    label: PROVIDER_NAMES[provider] || String(row.id),
    provider,
    accountId: account,
    poolId: isPlainObject(pool) && pool.provider && pool.account
      ? `${pool.provider}:${pool.account}`
      : (provider && account ? `${provider}:${account}` : null),
    state,
    basis,
    basisDeclared: !!declaredBasis,
    freshness,
    observedAt: factValue(res.observedAt),
    freshUntil: factValue(res.freshUntil),
    source: factValue(res.source),
    windows,
    balance,
    reauth,
    quotaEligibility,
    reasonCodes: allowReasonCodes(reasonCodes),
    // The disclosed, raw facts the text surfaces read: the reported plan
    // period end, the provider error and the state's reason code. They are
    // raw on purpose — the JSON carries the original value and the TEXT
    // boundary escapes it (#88).
    periodEnd: factValue(res.periodEnd),
    error: typeof res.error === 'string' ? res.error : null,
    stateReason,
  };
}

// The versioned view schema. Always valid: an empty route list is a valid
// document, and so is a route whose facts are unknown.
function buildViewSchema(snapshot, opts = {}) {
  const snap = isPlainObject(snapshot) ? snapshot : {};
  const ctx = { gate: isPlainObject(opts.gate) ? opts.gate : null };
  // The routes keep the CONFIGURATION order (the order the user set them up
  // in) — the order the approved #59 examples show. The snapshot already
  // assembles its route rows in that order.
  const rows = (Array.isArray(snap.routes) ? snap.routes : [])
    .filter((r) => isPlainObject(r) && r.configured === true);
  const routes = rows.map((row) => buildRouteSchema(row, ctx));

  const known = routes.filter((r) => r.state !== 'unknown').length;
  let status = 'ok';
  let reasonCodes = [];
  if (routes.length === 0) {
    status = 'empty';
    reasonCodes = ['no-routes-configured'];
  } else if (known === 0) {
    status = 'pending';
    reasonCodes = ['no-observed-state'];
  }

  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    generatedAt: typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : (typeof snap.generatedAt === 'string' ? snap.generatedAt : null),
    status,
    reasonCodes: allowReasonCodes(reasonCodes),
    routes,
  };
}

// ---- text rendering (Issue #59) ---------------------------------------------

function barFor(ratio) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

function formatCount(value) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

function formatAbsoluteTime(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return null;
  }
}

// A reset inside the next day is relative ("in 2h 14m"); anything further out
// is an absolute local timestamp ("Oct 15, 00:00 PDT").
function formatRelativeTime(value, now) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'overdue';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return null;
}

function formatResetAt(value, ctx) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const relative = formatRelativeTime(date, ctx.now);
  if (relative) return relative;
  return formatAbsoluteTime(date, ctx.timeZone) || String(value);
}

function countsText(w, short) {
  const remaining = w.remaining === null ? null : formatCount(w.remaining);
  const limit = w.limit === null ? null : formatCount(w.limit);
  let text;
  if (remaining !== null && limit !== null) text = `${remaining} / ${limit}`;
  else if (remaining !== null) text = remaining;
  else return null;
  if (short) return text;
  return w.unit ? `${text} ${w.unit} remaining` : `${text} remaining`;
}

function withLastSeen(value, route, ctx) {
  if (!route || route.freshness !== 'stale') return value;
  const seen = formatAbsoluteTime(route.observedAt, ctx.timeZone);
  return seen ? `${value} (last seen ${seen})` : value;
}

function viewNote(route) {
  if (route.reauth) {
    const target = route.reauth.url ? route.reauth.url : 'the provider console (reauth url unavailable)';
    const profile = route.reauth.profile
      ? ` (profile ${escapeControlChars(route.reauth.profile)})`
      : '';
    return `Browser session expired. Sign in again: ${target}${profile}`;
  }
  if (route.state === 'unknown' && route.basis === 'token-count') {
    return 'Token counts available; availability undetermined.';
  }
  if (route.error) return escapeControlChars(capText(route.error));
  if (route.stateReason) return escapeControlChars(route.stateReason);
  return '';
}

function isKnownState(state) {
  return state === 'healthy' || state === 'constrained' || state === 'exhausted';
}

// The expanded measurement rows of one route: the windows (barred when the
// state is known), the balance, the reset, the reported period end, the spent
// figures and the note.
function expandedRows(route, ctx) {
  const rows = [];
  const known = isKnownState(route.state);
  let basisShown = false;
  for (const w of route.windows) {
    const typeLabel = WINDOW_LABELS[w.type] || w.type || 'Quota';
    if (known && w.remainingRatio !== null) {
      const pct = Math.round(w.remainingRatio * 100);
      // The bar is 20 inner cells wide; the percentage is right-aligned in a
      // three-column field right after it, so a one-digit percent keeps the
      // "left" suffix in the same place.
      let value = `${barFor(w.remainingRatio)}   ${`${pct}%`.padStart(3)} left`;
      // The basis label rides the measurement (the owner's 2026-10-20
      // amendment) and only when the adapter DECLARED one.
      if (!basisShown && route.basisDeclared && BASIS_TEXT[route.basis]) {
        value += `  (${BASIS_TEXT[route.basis]})`;
        basisShown = true;
      }
      rows.push({ label: typeLabel, value: withLastSeen(value, route, ctx) });
    } else {
      const text = countsText(w, false);
      if (text) rows.push({ label: 'Counts', value: withLastSeen(text, route, ctx) });
    }
  }
  if (route.balance && route.balance.amount !== null) {
    rows.push({
      label: 'Balance',
      value: withLastSeen(formatMoney(route.balance.amount, route.balance.currency), route, ctx),
    });
  }
  const resets = (route.windows || []).filter((w) => w.resetAt);
  if (resets.length) {
    const parts = resets.map((w) => formatResetAt(w.resetAt, ctx));
    const value = resets.length > 1
      ? resets.map((w, i) => `${WINDOW_LABELS[w.type] || w.type || 'Quota'}: ${parts[i]}`).join(' | ')
      : parts[0];
    rows.push({ label: 'Reset', value });
  }
  if (route.periodEnd) {
    rows.push({ label: 'Period', value: `ends ${escapeControlChars(route.periodEnd)} (reported)` });
  }
  if (route.balance && route.balance.spent) {
    const spent = route.balance.spent;
    const parts = [];
    if (spent.daily !== null) parts.push(`Today: ${formatMoney(spent.daily, route.balance.currency)}`);
    if (spent.weekly !== null) parts.push(`This week: ${formatMoney(spent.weekly, route.balance.currency)}`);
    if (parts.length) rows.push({ label: 'Spent', value: parts.join(' | ') });
  }
  const note = viewNote(route);
  if (note) rows.push({ label: 'Note', value: note });
  return rows;
}

// One condensed row per measurement. The WINDOW column carries the basis
// (a token window reads "Tokens", a balance reads "Balance"), so the
// condensed layout needs no separate basis suffix.
function condensedRows(route) {
  const rows = [];
  const known = isKnownState(route.state);
  for (const w of route.windows) {
    const typeLabel = WINDOW_LABELS[w.type] || w.type || 'Quota';
    if (known && w.remainingRatio !== null) {
      rows.push({
        window: typeLabel,
        remaining: barFor(w.remainingRatio),
        left: `${Math.round(w.remainingRatio * 100)}%`,
      });
    } else {
      const text = countsText(w, true);
      if (text) rows.push({ window: typeLabel, remaining: text, left: '' });
    }
  }
  if (route.balance && route.balance.amount !== null) {
    rows.push({
      window: 'Balance',
      remaining: formatMoney(route.balance.amount, route.balance.currency),
      left: '',
    });
  }
  return rows;
}

function trimEnd(text) {
  return text.replace(/\s+$/, '');
}

function summaryLine(routes) {
  const counts = { healthy: 0, constrained: 0, exhausted: 0, unknown: 0 };
  for (const route of routes) {
    const state = isKnownState(route.state) ? route.state : 'unknown';
    counts[state] += 1;
  }
  return `${counts.healthy} healthy | ${counts.constrained} constrained | ${counts.exhausted} exhausted | ${counts.unknown} unknown`;
}

// The two approved text formats of the view schema.
function renderViewText(schema, opts = {}) {
  const doc = isPlainObject(schema) ? schema : {};
  const routes = Array.isArray(doc.routes) ? doc.routes : [];
  const ctx = {
    timeZone: typeof opts.timeZone === 'string' ? opts.timeZone : undefined,
    now: typeof opts.now === 'number' ? opts.now : Date.now(),
  };
  const lines = [];

  if (opts.condensed === true) {
    lines.push('VIEW-LIMITS | QUOTA REMAINING');
    lines.push('');
    lines.push(`${'PROVIDER'.padEnd(15)}${'WINDOW'.padEnd(9)}${'REMAINING'.padEnd(25)}${'LEFT'.padStart(4)}  STATE`);
    for (const route of routes) {
      const rows = condensedRows(route);
      rows.forEach((cells, index) => {
        const provider = index === 0 ? (route.label || route.id) : '';
        const state = index === 0 ? String(route.state || 'unknown').toUpperCase() : '';
        lines.push(trimEnd(
          `${provider.padEnd(15)}${cells.window.padEnd(9)}${cells.remaining.padEnd(25)}${cells.left.padStart(4)}  ${state}`,
        ));
      });
    }
    return lines;
  }

  lines.push('+---------------------------+');
  lines.push('|        View-Limits        |');
  lines.push('+---------------------------+');
  lines.push('');
  lines.push('QUOTA REMAINING');
  lines.push('');
  for (const route of routes) {
    lines.push(
      `${(route.label || route.id).padEnd(49)}${String(route.state || 'unknown').toUpperCase().padEnd(13)}${String(route.freshness || 'unknown').toUpperCase()}`,
    );
    for (const row of expandedRows(route, ctx)) {
      lines.push(`  ${row.label.padEnd(9)}${row.value}`);
    }
    lines.push('');
  }
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(summaryLine(routes));
  return lines;
}

module.exports = {
  VIEW_MODEL_SCHEMA_VERSION,
  XIAOMI_PROVIDER,
  buildViewModel,
  factValue,
  factText,
  finiteNumber,
  formatMoney,
  renderableRoute,
  reauthNote,
  // Issue #59 — the versioned view schema and its renderers.
  VIEW_SCHEMA_VERSION,
  buildViewSchema,
  renderViewText,
  escapeControlChars,
  validateReauthUrl,
  VIEW_REASON_CODES,
};