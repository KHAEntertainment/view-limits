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

// Xiaomi provider marker + dashboard URL. Mirrors lib/xiaomi-session.js's
// XIAOMI_PROVIDER and DASHBOARD_URL constants; duplicated here as plain
// literals so the view model never pulls the live adapter / cookie / metadata
// modules. Update both if either changes upstream.
const XIAOMI_PROVIDER = 'xiaomi';
const XIAOMI_DASHBOARD_URL = 'https://platform.xiaomimimo.com/';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
  const profile = reauth && reauth.profile ? ` (profile ${reauth.profile})` : '';
  const url = reauth && reauth.url ? reauth.url : XIAOMI_DASHBOARD_URL;
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
    if (res.error) return ` — ${String(res.error)}`;
    if (res.state && res.state.reason) return ` — ${res.state.reason}`;
    return '';
  }
  if (res.error) {
    const msg = String(res.error);
    const tail = msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
    return ` — ${tail} (rotate via /view-limits:update ${row.id})`;
  }
  if (res.state && res.state.reason) return ` — ${res.state.reason}`;
  return '';
}

function renderRouteText(row) {
  const res = isPlainObject(row.resource) ? row.resource : {};
  const state = factValue(res.state) || 'unknown';
  const quota = quotaText(res);
  const resetAt = factValue(res.resetAt);
  const reset = resetAt ? ` · resets ${new Date(resetAt).toLocaleString()}` : '';
  const note = noteText(row, res);
  const stale = res.freshness === 'stale' ? ' (stale)' : '';
  const binding = Array.isArray(row.boundBy) && row.boundBy.length
    ? ` · bound to ${row.boundBy.map((b) => `${b.harness}@${b.host}`).join(', ')}`
    : '';
  const modelsValue = factValue(row.models);
  const models = Array.isArray(modelsValue) && modelsValue.length
    ? ` · models ${modelsValue.join(', ')}`
    : '';
  return `    ${row.id}: ${state}${quota ? ' · ' + quota : ''}${reset}${note}${binding}${models}${stale}`;
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
};