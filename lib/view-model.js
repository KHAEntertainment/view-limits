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

const { basisOf, STATES, BASES } = require('./normalize');
const { parseStrictIsoTimestamp, decide: gateDecide } = require('./gate');
const { isConfigObsolete } = require('./monitor-schema');
// #120 — the region table for the human fix of a built-in refusal (Issue
// #113). It is the source of the allowed-region list: the fix never echoes
// the offending endpoint or region string, only the table's own names.
const { regionList } = require('./config');

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
// The whole control class is escaped, not just the C0 range: DEL (U+007F)
// and the C1 range (U+0080-U+009F) reach the terminal too — NEL and CSI
// among them.
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
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
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
  // #99 — the legacy text boundary. Every provider- or config-derived string
  // that reaches a rendered line goes through the ONE sanitizer (textCell).
  // A value without control characters renders byte-identically.
  const availability = avail === true ? 'available'
    : avail === false ? 'unavailable'
    : `availability unknown${h.available && h.available.reason ? ` — ${textCell(h.available.reason)}` : ''}`;
  const refs = Array.isArray(h.sessionRefs) ? h.sessionRefs.length : 0;
  const resources = Array.isArray(h.resourceRefs) ? h.resourceRefs.length : 0;
  const defaults = isPlainObject(h.defaults)
    ? Object.entries(h.defaults).map(([k, f]) => `${textCell(k)}=${textCell(factText(f))}`).join(' ')
    : '';
  return `    ${textCell(key.harness || 'unknown')} (${textCell(key.surface || 'unknown')}) @ ${textCell(key.host || 'unknown')}: ${availability}` +
    `${refs ? ` · ${refs} session(s)` : ''}${resources ? ` · ${resources} resource ref(s)` : ''}` +
    `${defaults ? ` · defaults: ${defaults}` : ''}`;
}

function renderSessionText(s) {
  const key = isPlainObject(s.key) ? s.key : {};
  const bits = [];
  if (factValue(s.harness) !== null) bits.push(`harness ${textCell(factValue(s.harness))}`);
  if (factValue(s.surface) !== null) bits.push(textCell(factValue(s.surface)));
  if (factValue(s.title) !== null) bits.push(`"${textCell(factValue(s.title))}"`);
  const active = factValue(s.active);
  if (active !== null) bits.push(active ? 'active' : 'idle');
  if (factValue(s.isSelf) === true) bits.push('this requester');
  return `    session ${textCell(key.agentId || 'unknown')} @ ${textCell(key.host || 'unknown')}: ${bits.join(' · ') || 'no facts'}`;
}

function renderProfileText(p) {
  const key = isPlainObject(p.key) ? p.key : {};
  const bits = [];
  if (factValue(p.authStatus) !== null) bits.push(`auth ${textCell(factValue(p.authStatus))}`);
  if (factValue(p.rateLimitStatus) !== null) bits.push(`rate limits ${textCell(factValue(p.rateLimitStatus))}`);
  const usageAt = factValue(p.usageUpdatedAt);
  bits.push(usageAt ? `usage observed ${textCell(usageAt)}` : 'usage unobserved');
  if (factValue(p.nativeRateLimits) !== null) bits.push('native rate limits observed');
  return `    profile ${textCell(key.provider || 'unknown')}/${textCell(key.profileId || 'unknown')} @ ${textCell(key.host || 'unknown')}: ${bits.join(' · ')}`;
}

// ---- route text + structured row --------------------------------------------

function quotaText(res) {
  const balance = isPlainObject(res.balance) ? res.balance : null;
  // #99 — the currency is provider-supplied and used to reach the text raw.
  // It is trimmed exactly as before (so an ordinary currency renders
  // byte-identically) and then escaped through the one sanitizer. A
  // non-string currency stays non-string: formatMoney ignores it, so it
  // renders as no currency at all - unchanged.
  const balanceCurrency = balance
    ? (typeof balance.currency === 'string' ? textCell(balance.currency.trim()) : balance.currency)
    : '';
  const formattedBalance = balance ? formatMoney(balance.available, balanceCurrency) : null;
  if (formattedBalance) {
    let line = `balance ${formattedBalance}`;
    if (isPlainObject(balance.spent)) {
      const spentParts = [];
      const daily = formatMoney(balance.spent.daily, balanceCurrency);
      const weekly = formatMoney(balance.spent.weekly, balanceCurrency);
      if (daily) spentParts.push(`${daily} today`);
      if (weekly) spentParts.push(`${weekly} week`);
      if (spentParts.length) line += ` · spent ${spentParts.join(' / ')}`;
    }
    if (isPlainObject(balance.limit)) {
      const cap = formatMoney(balance.limit.amount, balanceCurrency);
      if (cap) line += ` · ${cap} ${textCell(balance.limit.period || balance.limit.reset || 'period')} cap`;
    }
    return line;
  }
  if (isPlainObject(res.usage)) {
    const usage = res.usage;
    const usageCurrency = typeof usage.currency === 'string' ? textCell(usage.currency.trim()) : usage.currency;
    const spentParts = [];
    const daily = formatMoney(usage.daily, usageCurrency);
    const weekly = formatMoney(usage.weekly, usageCurrency);
    const monthly = formatMoney(usage.monthly, usageCurrency);
    if (daily) spentParts.push(`${daily} today`);
    if (weekly) spentParts.push(`${weekly} week`);
    if (monthly) spentParts.push(`${monthly} month`);
    if (spentParts.length) return `spent ${spentParts.join(' / ')}`;
  }
  if (Array.isArray(res.windows) && res.windows.length) {
    return res.windows.map((w) => {
      if (w.limit > 0 && w.remaining != null) return `${textCell(String(w.type))} ${Math.round((w.remaining / w.limit) * 100)}%`;
      return `${textCell(String(w.type))} ${textCell(String(w.remaining))}/${textCell(String(w.limit))}`;
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
    // #99 — the route id is config-derived: escape it in the hint too.
    // Q34-A — the id is context, not an argument: `/view-limits:update` takes
    // none, so the command stays last on the line the user copies.
    return ` — ${tail} (rotate ${textCell(String(row.id))} via /view-limits:update)`;
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
  // #99 — the TEXT boundary escapes the disclosed value through the ONE
  // sanitizer (textCell): it covers the whole control class — C0, DEL
  // (U+007F) and the C1 range (U+0080-U+009F) — so a provider-supplied
  // currentPeriodEnd can neither fabricate a route line nor rewrite the
  // terminal. The structured JSON still carries the ORIGINAL value
  // (serializeRoute.periodEnd is the raw fact), so the disclosed value is
  // never corrupted for machine consumers.
  //
  // The value is JSON-escaped FIRST and then sanitized: JSON.stringify
  // already escapes C0 (and `"` and `\`), and the sanitizer adds the two
  // classes JSON leaves raw — DEL and the C1 range. A control-free period
  // end therefore renders exactly as it did before #99, `"` and `\`
  // included; only DEL and C1 change, from raw to escaped.
  const period = periodEnd
    ? ` · plan period ends ${textCell(JSON.stringify(String(periodEnd)).slice(1, -1))} (reported)`
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
    ? ` · models ${modelsValue.map((m) => textCell(String(m))).join(', ')}`
    : '';
  return `    ${textCell(String(row.id))}: ${textCell(state)}${quota ? ' · ' + quota : ''}${basis}${period}${reset}${note}${binding}${models}${stale}`;
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
    ade ? textCell(ade) : null,
    agentId != null ? `agent ${textCell(String(agentId))}` : null,
    epicId != null ? `epic ${textCell(String(epicId))}` : null,
  ].filter(Boolean).join(' · ');
  const harness = factValue(c.harness);
  const surface = factValue(c.surface);
  const host = factValue(c.host);
  const where = [
    harness ? textCell(harness) : null,
    surface ? textCell(surface) : null,
    host ? textCell(host) : null,
  ].filter(Boolean).join(' · ');
  const differsFromDefault = factValue(c.differsFromDefault) === true;
  const modelsLine = `    models: configured ${textCell(factText(c.configuredModel))} · default ${textCell(factText(c.defaultModel))} · effective ${textCell(factText(c.effectiveModel))}${differsFromDefault ? ' (differs from default)' : ''}`;

  const selProfile = factValue(c.selectedProfile);
  const selAccount = factValue(c.selectedAccount);
  const selectionPresent = selProfile !== null || selAccount !== null;
  const selectionLine = selectionPresent
    ? `    selection: profile ${textCell(factText(c.selectedProfile))} · account ${textCell(factText(c.selectedAccount))}`
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
  const poolReasonLine = poolReason ? `    reason: ${textCell(String(poolReason.summary))}` : null;

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
  const diagnosticLines = nonPoolDiagnostics.map((d) => `  notice [${textCell(d.scope || 'snapshot')}] ${textCell(String(d.code))} — ${textCell(String(d.summary))}`);

  // Compose final text lines in the same order as the prior renderer.
  const lines = [];
  lines.push(`view-limits runtime inventory — generated ${textCell(String(snap.generatedAt))} · completeness ${textCell(String(snap.completeness))}`);
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
  lines.push(`  cache updated ${textCell(updatedAt || 'never')}`);

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
//
// The names come from the owner's approved examples (#59) and from the
// adapters' own product names. The recipe catalog (lib/recipes/index.js)
// carries NO display name of its own — its entries are ids — so this map is
// the one place a product name lives.
const PROVIDER_NAMES = Object.freeze({
  minimax: 'MiniMax',
  kimi: 'Kimi',
  glm: 'Z.ai / GLM',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  xiaomi: 'Xiaomi MiMo',
});

// Recipe display names. A recipe route's `provider` is a free-form custom id
// (the catalog deliberately does not fix it), so the RECIPE is the stable
// identity a product name can key on.
const RECIPE_NAMES = Object.freeze({
  'alibaba-coding-plan': 'Alibaba Cloud',
  'stepfun-plan': 'StepFun',
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
  'config-absent', 'invalid-state', 'invalid-basis', 'no-native-facts',
  'native-unavailable', 'freshness-unproven', 'state-unknown',
  // Issue #60 — the collection that produced (or did not produce) this
  // route's facts. Additive: the #59 vocabulary above is unchanged.
  'collection-failed', 'collection-pending',
]);

// Issue #120 — the built-in refusal reasons (Issue #113, contract C-004).
// A refused route carries one of these as its stable refusal code. They are
// deliberately NOT added to VIEW_REASON_CODES: that allowlist also gates the
// LAN projection (lib/dashboard/lan-redact.js imports it), and C-003 keeps
// the LAN vocabulary fixed. Instead the refusal rides its own additive route
// block (`refusal`), which the LAN allowlist never copies.
const REFUSAL_REASONS = Object.freeze([
  'built-in-endpoint-refused',
  'unknown-region',
]);

// The short human fix for a refusal. It is built ONLY from fixed strings and
// the provider's region table (lib/config.js#regionList) — never from the
// route's raw monitor endpoint/region values, so a user-typed string cannot
// reach the view through the fix.
function refusalHint(reason, provider) {
  if (reason === 'built-in-endpoint-refused') {
    return 'use monitor.region instead of monitor.endpoint';
  }
  if (reason === 'unknown-region') {
    const list = regionList(provider);
    if (list && list.length) return `region must be one of: ${list.join(', ')}`;
    return 'region must be one of the provider\'s regions';
  }
  return null;
}

// Issue #60 — the collection vocabulary. The envelope carries ONE block that
// says what the live collection did, and every route carries the outcome of
// ITS OWN collection. Both are additive: no #59 field is removed or renamed.
//
// The collection outcome and the per-route outcome are two different
// vocabularies: the first is what the OPERATION did, the second is what
// happened to ONE route inside it.
const COLLECTION_OUTCOMES = Object.freeze([
  'completed', 'partial', 'in-progress', 'failed', 'no-credentials', 'not-run',
]);

const ROUTE_COLLECTION_OUTCOMES = Object.freeze([
  'completed', 'failed', 'pending', 'skipped',
]);

const BAR_WIDTH = 20;

function numericOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// A provider- or config-derived key (a window type, a provider id, a recipe
// id, a basis) must never resolve to an INHERITED object member:
// `WINDOW_LABELS['constructor']` is Object's constructor, not a label, and
// using it as one crashes the renderer. Every lookup keyed by provider data
// goes through this own-property check; an unknown key is simply unknown.
function ownLookup(map, key) {
  if (typeof key !== 'string' || !key) return null;
  return Object.hasOwn(map, key) ? map[key] : null;
}

// THE text boundary. Every provider- or config-derived string that reaches a
// rendered line goes through this one function, so a newline or a control
// character in a currency, a window type, a reset string, a provider name or
// a route id can never fabricate a line. The structured JSON keeps the raw
// values.
function textCell(value) {
  if (value === null || value === undefined) return '';
  return escapeControlChars(String(value));
}

// The display name of a route: the recipe first (a recipe route's provider id
// is free-form), then the provider, then the route id. An unknown key is
// never resolved against an inherited object member.
function providerLabel(provider, recipe, routeId) {
  return ownLookup(RECIPE_NAMES, recipe)
    || ownLookup(PROVIDER_NAMES, provider)
    || routeId;
}

// The text label of one window. An unknown type keeps its own name (escaped
// at the boundary) rather than becoming an inherited member.
function windowLabel(type) {
  return ownLookup(WINDOW_LABELS, type)
    || (typeof type === 'string' && type ? type : 'Quota');
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
//
// The string is checked BEFORE it is parsed. `new URL()` silently strips tab
// and newline, so a URL carrying an embedded newline would parse cleanly and
// then be interpolated into the route line as a second one. The checked
// string itself is what is returned, so what is displayed is what was
// validated.
function validateReauthUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { value: null, reasonCodes: ['reauth-url-invalid'] };
  }
  const text = raw.trim();
  // No control character (the whole class, C1 included), no whitespace and
  // no backslash: a URL that needs any of them is not one we will display.
  if (/[\p{Cc}\s\\]/u.test(text)) {
    return { value: null, reasonCodes: ['reauth-url-invalid'] };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { value: null, reasonCodes: ['reauth-url-invalid'] };
  }
  if (parsed.protocol !== 'https:') return { value: null, reasonCodes: ['reauth-url-invalid'] };
  if (parsed.username || parsed.password) return { value: null, reasonCodes: ['reauth-url-invalid'] };
  if (parsed.search) return { value: null, reasonCodes: ['reauth-url-invalid'] };
  return { value: text, reasonCodes: [] };
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

// ---- ONE freshness predicate and ONE state rule ----------------------------
//
// The external routes and the native profiles answer the same two questions
// with the same two functions:
//
//   * Is the observation CURRENT? Positive evidence only: a valid
//     observation time AND a valid, unexpired deadline. A missing, null or
//     malformed deadline is NOT "fresh until further notice" — the currency
//     of the observation is unproven, so the freshness is unknown.
//   * What STATE may be claimed? Only a current observation may carry one.
//     Anything else is `unknown` with a reason code.
//
// There is no second implementation of either question in this file.

// A strict instant: an ISO 8601 timestamp with a real calendar, or null.
function instantOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = parseStrictIsoTimestamp(value);
  return t === null ? null : t;
}

// The freshness of one observation. `obsolete` marks a cached entry the
// configuration has moved past - the gate refuses such an entry too.
function freshnessOf({ observedAt, freshUntil, now, obsolete = false }) {
  if (obsolete === true) return { freshness: 'unknown', reasonCodes: ['config-revision-obsolete'] };
  const until = instantOf(freshUntil);
  if (until === null) return { freshness: 'unknown', reasonCodes: ['freshness-unproven'] };
  if (until <= now) return { freshness: 'stale', reasonCodes: ['stale-observation'] };
  if (instantOf(observedAt) === null) return { freshness: 'unknown', reasonCodes: ['freshness-unproven'] };
  return { freshness: 'fresh', reasonCodes: [] };
}

// The state an observation may claim.
function stateFor(rawState, freshness) {
  if (freshness.freshness !== 'fresh') return { state: 'unknown', reasonCodes: freshness.reasonCodes };
  return { state: rawState, reasonCodes: [] };
}


// The gate's own decision, asked with a fixed deny-mode gate config so the
// answer is the gate's RULE (fresh + unobsolete + exhausted -> deny) and not
// a function of the user's configured gate mode.
const GATE_PROBE_CONFIG = Object.freeze({ gate: { mode: 'deny', injectContext: false } });

// The quota eligibility of a ROUTE: the authoritative pure decision of
// lib/gate.js, on the same raw entry, the same configured route and the same
// clock. The rule is not copied or redefined here - the view reads the gate's
// answer:
//
//   deny                       -> ineligible (the gate would block dispatch)
//   allow, with a refresh asked -> unresolved  (the gate fails open on an
//                                  entry it cannot trust; the view makes no
//                                  claim either)
//   allow                      -> eligible, only if the raw entry's state is
//                                  healthy/constrained, the route is fresh AND
//                                  the DISPLAYED state is healthy/constrained;
//                                  otherwise unresolved
//
// The displayed state and freshness stay conservative (the shared
// freshnessOf predicate), so the two can differ in what they SAY about a
// malformed entry - but the eligibility is never looser than the gate's
// decision.
function eligibilityFromGate(ctx, routeId, freshness, displayedState) {
  const gate = ctx.gate;
  const routes = isPlainObject(gate) && isPlainObject(gate.routes) ? gate.routes : {};
  const entries = isPlainObject(gate) && isPlainObject(gate.entries) ? gate.entries : {};
  const route = routes[routeId];
  const entry = entries[routeId];
  // No gate counterpart for this route: nothing proves it eligible.
  if (!isPlainObject(route) || !isPlainObject(entry)) {
    return { value: 'unresolved', reasonCodes: ['no-fresh-observation'] };
  }
  const now = typeof gate.now === 'number' ? gate.now : ctx.now;
  const decision = gateDecide({ route, entry, now, config: GATE_PROBE_CONFIG });
  if (decision.action === 'deny') return { value: 'ineligible', reasonCodes: ['fresh-exhausted'] };
  if (decision.refresh === true) return { value: 'unresolved', reasonCodes: ['no-fresh-observation'] };
  // A plain allow is the gate FAILING OPEN: it says nothing about the quota
  // (the gate allows anything that is not exhausted). Only a state the gate
  // could read as capacity - healthy or constrained - proves the route is
  // eligible. Anything else - unknown, or a value outside the enum - stays
  // unresolved, so the view never claims capacity it cannot show.
  const state = isPlainObject(entry.status) ? entry.status.state : null;
  if (state !== 'healthy' && state !== 'constrained') return { value: 'unresolved', reasonCodes: ['state-unknown'] };
  // The gate reads the entry's expiry alone, so an entry it calls fresh can
  // still be unproven for the view (no observation time). The route's OWN
  // freshness is required too, so the eligibility never claims a capacity
  // the route's state refuses to show.
  if (!isPlainObject(freshness) || freshness.freshness !== 'fresh') {
    return { value: 'unresolved', reasonCodes: ['no-fresh-observation'] };
  }
  // The raw entry is not always what the row DISPLAYS: the busy view shows a
  // pending Xiaomi projection (state unknown, no windows) beside a raw entry
  // the gate still reads as healthy and fresh (a zero-TTL entry is fresh at
  // its own instant). A row that displays no known capacity is never
  // eligible — unknown is never eligible, whatever the raw entry says.
  if (displayedState !== 'healthy' && displayedState !== 'constrained') {
    return { value: 'unresolved', reasonCodes: ['state-unknown'] };
  }
  return { value: 'eligible', reasonCodes: [] };
}

// Whether the configuration has moved past a cached entry (the gate refuses
// such an entry, so the view must not read it as current either).
function isRouteObsolete(ctx, routeId) {
  if (!isPlainObject(ctx.gate)) return false;
  const entries = isPlainObject(ctx.gate.entries) ? ctx.gate.entries : {};
  const routes = isPlainObject(ctx.gate.routes) ? ctx.gate.routes : {};
  const route = routes[routeId];
  const entry = entries[routeId];
  if (!isPlainObject(route) || !isPlainObject(entry)) return false;
  try {
    return isConfigObsolete(entry, route) === true;
  } catch {
    return false;
  }
}


// ---- the collection block (Issue #60) --------------------------------------
//
// The normalized collection block: the ONE place the envelope says what the
// live collection did.
//
// The normalization is defensive: an unknown outcome is a failure, never a
// silent pass, and a malformed per-route row is dropped rather than carried
// into the envelope. The block is always a valid object or null — the
// envelope never grows a half-built field.
function buildCollectionBlock(raw) {
  if (!isPlainObject(raw)) return null;
  const outcome = typeof raw.outcome === 'string' && COLLECTION_OUTCOMES.includes(raw.outcome)
    ? raw.outcome
    : 'failed';
  const routes = (Array.isArray(raw.routes) ? raw.routes : [])
    .filter(isPlainObject)
    .map((r) => ({
      id: typeof r.id === 'string' ? r.id : String(r.id),
      outcome: typeof r.outcome === 'string' && ROUTE_COLLECTION_OUTCOMES.includes(r.outcome)
        ? r.outcome
        : 'failed',
      error: typeof r.error === 'string' && r.error ? r.error : null,
    }));
  return {
    outcome,
    published: raw.published === true,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    routes,
    // Issue #60 (B3 / round-2 R2-1) — the bounded native observation's
    // outcome, additive. `unavailable` (no CLI installed) is not a failure;
    // `unknown` (e.g. missing launch identity) is not a failure either.
    native: isPlainObject(raw.native) && typeof raw.native.outcome === 'string'
      && ['completed', 'failed', 'unavailable', 'unknown'].includes(raw.native.outcome)
      ? {
        outcome: raw.native.outcome,
        codes: Array.isArray(raw.native.codes)
          ? raw.native.codes.filter((c) => typeof c === 'string')
          : [],
        error: typeof raw.native.error === 'string' && raw.native.error ? raw.native.error : null,
      }
      : null,
  };
}

// The collection outcome of ONE route, or null when the collection did not
// cover it. The route's own facts are untouched: a failed collection keeps
// the prior observation and its age, and the failure is disclosed beside it.
function collectionFor(ctx, routeId) {
  const block = ctx && isPlainObject(ctx.collection) ? ctx.collection : null;
  if (!block || !Array.isArray(block.routes)) return null;
  const row = block.routes.find((r) => isPlainObject(r) && r.id === routeId);
  if (!row) return null;
  return { outcome: row.outcome, error: row.error || null };
}

function buildRouteSchema(row, ctx) {
  const res = isPlainObject(row.resource) ? row.resource : {};
  const provider = factValue(row.provider);
  const account = factValue(row.account);
  const pool = factValue(row.pool);
  const recipe = ctx.recipeOf && typeof ctx.recipeOf[row.id] === 'string' ? ctx.recipeOf[row.id] : null;
  // Issue #60 — what this route's own collection did. It never replaces the
  // route's facts: a failed collection keeps the prior observation (and its
  // age) and discloses the failure beside it.
  const collection = collectionFor(ctx, String(row.id));

  const stateFact = isPlainObject(res.state) ? res.state : null;
  // A cached state outside the enum is not a state: it becomes `unknown`
  // with a reason code. The same for a basis outside its four values.
  const cachedState = factValue(res.state);
  const validState = typeof cachedState === 'string' && STATES.includes(cachedState) ? cachedState : null;
  const invalidState = cachedState !== null && validState === null;
  const rawState = validState === null ? 'unknown' : validState;
  const stateReason = stateFact && typeof stateFact.reason === 'string' ? stateFact.reason : null;

  // Issue #120 — the built-in refusal (Issue #113). The snapshot projects the
  // stable code from detail.reason; the view maps it to a machine-readable
  // code plus a short human fix derived from the region table. Only the two
  // known refusal codes produce a block — anything else is ignored.
  const refusalReason = typeof res.reason === 'string' && REFUSAL_REASONS.includes(res.reason)
    ? res.reason : null;
  const refusal = refusalReason
    ? { reason: refusalReason, fix: refusalHint(refusalReason, provider) }
    : null;

  // The basis: an EXPLICIT adapter-declared basis wins; otherwise it is
  // derived from the evidence the route carries (lib/normalize.js#basisOf).
  const cachedBasis = factValue(res.basis);
  const declaredBasis = typeof cachedBasis === 'string' && BASES.includes(cachedBasis) ? cachedBasis : null;
  const invalidBasis = cachedBasis !== null && declaredBasis === null;
  const basis = declaredBasis || basisOf({ windows: res.windows, balance: res.balance });

  const windows = buildWindows(res.windows, basis);
  const balance = buildBalance(res.balance);
  const reauth = buildReauth(res.reauth);

  const freshness = freshnessOf({
    observedAt: factValue(res.observedAt),
    freshUntil: factValue(res.freshUntil),
    now: ctx.now,
    obsolete: isRouteObsolete(ctx, row.id),
  });

  // Stale is never healthy: a route whose observation is not current is
  // serialized as unknown, and its last-known facts stay visible.
  const claimed = stateFor(rawState, freshness);
  const state = claimed.state;

  const reasonCodes = [];
  if (invalidState) reasonCodes.push('invalid-state');
  if (invalidBasis) reasonCodes.push('invalid-basis');
  for (const c of claimed.reasonCodes) reasonCodes.push(c);
  if (state === 'unknown' && stateReason) reasonCodes.push(stateReason);
  if (windows.some((w) => w.unit === null)) reasonCodes.push('window-unit-unavailable');
  if (reauth) {
    reasonCodes.push('reauth-required');
    for (const c of reauth.reasonCodes) reasonCodes.push(c);
  }

  // The quota eligibility IS the gate's own decision (lib/gate.js#decide), on
  // the same raw entry, the same configured route and the same clock. The
  // rule is not copied or redefined here.
  const eligibility = eligibilityFromGate(ctx, String(row.id), freshness, state);
  const quotaEligibility = eligibility.value;
  for (const c of eligibility.reasonCodes) reasonCodes.push(c);
  // Issue #60 — the collection outcome is disclosed in the standard
  // reason-code vocabulary, so a consumer sees it without knowing the
  // collection block exists.
  if (collection) {
    if (collection.outcome === 'failed') reasonCodes.push('collection-failed');
    else if (collection.outcome === 'pending') reasonCodes.push('collection-pending');
  }

  return {
    id: String(row.id),
    label: providerLabel(provider, recipe, String(row.id)),
    provider,
    recipe,
    accountId: account,
    poolId: isPlainObject(pool) && pool.provider && pool.account
      ? `${pool.provider}:${pool.account}`
      : (provider && account ? `${provider}:${account}` : null),
    state,
    basis,
    basisDeclared: !!declaredBasis,
    freshness: freshness.freshness,
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
    // Issue #120 — the ADDITIVE built-in refusal block (reason + human fix);
    // null for every non-refused route.
    refusal,
    // Issue #60 — the ADDITIVE per-route collection outcome.
    collection,
  };
}

// ---- native profile projection (Issue #59 scope) ---------------------------
//
// A native profile is NOT a route. Its identity is the composite
// {host, provider, profileId} — the harness's own profile — and its quota
// comes from the harness's native rate-limit facts, not from a provider
// adapter. The facts are projected into typed windows; an unknown or stale
// observation is preserved as unknown and never promoted.
//
// The profiles live in the JSON envelope ONLY. The text layouts show
// providers, as the owner-approved examples do; a profile row in the text is
// #62's design review.

function isoFromEpoch(value) {
  const n = numericOrNull(value);
  if (n === null) return null;
  const ms = Math.abs(n) < 1e12 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buildProfileSchema(row, ctx) {
  const key = isPlainObject(row.key) ? row.key : {};
  const reasonCodes = [];
  const windows = [];
  let state = 'unknown';
  let freshness = 'unknown';
  let observedAt = null;

  const nativeFact = isPlainObject(row.nativeRateLimits) ? row.nativeRateLimits : null;
  const known = !!(nativeFact
    && nativeFact.provenance !== 'unknown'
    && nativeFact.value !== null && nativeFact.value !== undefined);
  if (!known) {
    reasonCodes.push('no-native-facts');
  } else {
    const native = isPlainObject(nativeFact.value) ? nativeFact.value : null;
    observedAt = typeof nativeFact.observedAt === 'string' ? nativeFact.observedAt : null;
    // The SAME freshness predicate the routes use: positive evidence only.
    // A native fact with no expiry is not fresh until further notice - its
    // currency is unproven, so it stays unknown with a diagnostic.
    const observed = freshnessOf({
      observedAt: nativeFact.observedAt,
      freshUntil: nativeFact.freshUntil,
      now: ctx.now,
    });
    freshness = observed.freshness;
    for (const c of observed.reasonCodes) reasonCodes.push(c);
    if (native && native.available === false) {
      reasonCodes.push('native-unavailable');
    } else if (native && isPlainObject(native.fiveHour)) {
      const used = numericOrNull(native.fiveHour.usedPercent);
      if (used !== null) {
        const remaining = Math.max(0, 100 - used);
        const ratio = remaining / 100;
        windows.push({
          type: 'rolling-5h',
          unit: 'percent',
          remaining,
          limit: 100,
          remainingRatio: ratio,
          resetAt: isoFromEpoch(native.fiveHour.resetsAt),
        });
        // The state comes from the native facts themselves, through the SAME
        // state rule the routes use: only a current observation may carry
        // one, so an unproven or expired observation stays unknown.
        const derived = ratio <= 0 ? 'exhausted' : (ratio < ctx.threshold ? 'constrained' : 'healthy');
        const claimed = stateFor(derived, observed);
        state = claimed.state;
        for (const c of claimed.reasonCodes) reasonCodes.push(c);
      }
    }
  }

  const usageAt = factValue(row.usageUpdatedAt);
  return {
    // The composite profile identity, kept separate from any route identity.
    identity: {
      host: key.host || null,
      provider: key.provider || null,
      profileId: key.profileId || null,
    },
    harness: factValue(row.harness),
    authStatus: factValue(row.authStatus),
    rateLimitStatus: factValue(row.rateLimitStatus),
    state,
    freshness,
    observedAt: observedAt || usageAt,
    usageAt,
    windows,
    balance: null,
    reasonCodes: allowReasonCodes(reasonCodes),
  };
}

// The versioned view schema. Always valid: an empty route list is a valid
// document, and so is a route whose facts are unknown.
function buildViewSchema(snapshot, opts = {}) {
  const snap = isPlainObject(snapshot) ? snapshot : {};
  const ctx = {
    gate: isPlainObject(opts.gate) ? opts.gate : null,
    // The recipe of each route (its stable provider identity, when it has
    // one). A recipe route's provider id is free-form, so the product name
    // keys on the recipe.
    recipeOf: isPlainObject(opts.recipeOf) ? opts.recipeOf : {},
    // The threshold the native profile projection uses (the same one the
    // gate marks a route constrained at).
    threshold: typeof opts.threshold === 'number' && Number.isFinite(opts.threshold)
      ? opts.threshold : 0.2,
    now: typeof opts.now === 'number' ? opts.now : Date.now(),
    // Issue #60 — the collection block, normalized. It is additive: the
    // #59 fields above are untouched.
    collection: buildCollectionBlock(opts.collection),
  };
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

  // The native profiles are a separate section: they are not routes, and they
  // are never merged into one.
  const profileRows = Array.isArray(snap.profiles) ? snap.profiles : [];
  const profiles = profileRows.filter(isPlainObject).map((row) => buildProfileSchema(row, ctx));

  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    generatedAt: typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : (typeof snap.generatedAt === 'string' ? snap.generatedAt : null),
    status,
    reasonCodes: allowReasonCodes(reasonCodes),
    // Issue #60 — what the live collection did. Null when the schema was
    // built without one (a cache-only consumer).
    collection: ctx.collection,
    routes,
    profiles,
  };
}

// ---- text rendering (Issue #59) ---------------------------------------------

// The percentage of a ratio, as text ("72%"). A helper, so the renderers
// never build a percentage out of a nested template.
function pctLabel(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return `${Math.round(ratio * 100)}%`;
}

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
  if (!Number.isFinite(date.getTime())) return textCell(value);
  const relative = formatRelativeTime(date, ctx.now);
  if (relative) return relative;
  return formatAbsoluteTime(date, ctx.timeZone) || textCell(value);
}

function countsText(w, short) {
  const remaining = w.remaining === null ? null : formatCount(w.remaining);
  const limit = w.limit === null ? null : formatCount(w.limit);
  let text;
  if (remaining !== null && limit !== null) text = `${textCell(remaining)} / ${textCell(limit)}`;
  else if (remaining !== null) text = textCell(remaining);
  else return null;
  if (short) return text;
  return w.unit ? `${textCell(text)} ${textCell(w.unit)} remaining` : `${textCell(text)} remaining`;
}

// A window whose counts are unknown but whose percentage is known is still a
// measurement: it is rendered as the plain percentage, with NO bar (the state
// may be unknown or stale) and marked last-seen when the observation is not
// fresh. Dropping it would make the text disagree with the JSON.
function percentText(w) {
  if (w.remainingRatio === null) return null;
  return `${textCell(pctLabel(w.remainingRatio))} left`;
}

function withLastSeen(value, route, ctx) {
  if (!route || route.freshness !== 'stale') return value;
  const seen = formatAbsoluteTime(route.observedAt, ctx.timeZone);
  return seen ? `${textCell(value)} (last seen ${textCell(seen)})` : textCell(value);
}

function viewNote(route) {
  if (route.reauth) {
    // Defense in depth: the URL was validated before it was stored, and it
    // is escaped again here, so no reauth field can reach the text as a
    // second line.
    const target = route.reauth.url
      ? textCell(route.reauth.url)
      : 'the provider console (reauth url unavailable)';
    const profile = route.reauth.profile
      ? ` (profile ${textCell(route.reauth.profile)})`
      : '';
    return `Browser session expired. Sign in again: ${textCell(target)}${textCell(profile)}`;
  }
  if (route.state === 'unknown' && route.basis === 'token-count') {
    return 'Token counts available; availability undetermined.';
  }
  if (route.error) return textCell(capText(route.error));
  if (route.stateReason) return textCell(route.stateReason);
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
    const typeLabel = textCell(windowLabel(w.type));
    if (known && w.remainingRatio !== null) {
      // The bar is 20 inner cells wide; the percentage is right-aligned in a
      // three-column field right after it, so a one-digit percent keeps the
      // "left" suffix in the same place.
      let value = `${barFor(w.remainingRatio)}   ${textCell(pctLabel(w.remainingRatio)).padStart(3)} left`;
      // The basis label rides the measurement (the owner's 2026-10-20
      // amendment) and only when the adapter DECLARED one.
      if (!basisShown && route.basisDeclared && ownLookup(BASIS_TEXT, route.basis)) {
        value += `  (${textCell(ownLookup(BASIS_TEXT, route.basis))})`;
        basisShown = true;
      }
      rows.push({ label: typeLabel, value: withLastSeen(value, route, ctx) });
    } else {
      // An unknown or stale window: no bar. The raw counts are shown when
      // they are known; otherwise the known percentage is shown as plain
      // text, so the measurement never disappears from the text.
      const text = countsText(w, false);
      if (text) rows.push({ label: 'Counts', value: withLastSeen(text, route, ctx) });
      else {
        const percent = percentText(w);
        if (percent) rows.push({ label: typeLabel, value: withLastSeen(percent, route, ctx) });
      }
    }
  }
  if (route.balance && route.balance.amount !== null) {
    rows.push({
      label: 'Balance',
      value: withLastSeen(balanceText(route.balance), route, ctx),
    });
  }
  const resets = (route.windows || []).filter((w) => w.resetAt);
  if (resets.length) {
    const parts = resets.map((w) => formatResetAt(w.resetAt, ctx));
    const value = resets.length > 1
      ? resets.map((w, i) => `${textCell(windowLabel(w.type))}: ${textCell(parts[i])}`).join(' | ')
      : parts[0];
    rows.push({ label: 'Reset', value });
  }
  if (route.periodEnd) {
    rows.push({ label: 'Period', value: `ends ${textCell(route.periodEnd)} (reported)` });
  }
  if (route.balance && route.balance.spent) {
    const spent = route.balance.spent;
    const parts = [];
    if (spent.daily !== null) parts.push(`Today: ${balanceText({ amount: spent.daily, currency: route.balance.currency })}`);
    if (spent.weekly !== null) parts.push(`This week: ${balanceText({ amount: spent.weekly, currency: route.balance.currency })}`);
    if (parts.length) rows.push({ label: 'Spent', value: parts.join(' | ') });
  }
  const note = viewNote(route);
  if (note) rows.push({ label: 'Note', value: note });
  return rows;
}

// The money cell. The currency is provider-supplied, so it goes through the
// one text boundary like every other provider string; the amount's own
// formatting (the "<0.01" sentinel) comes from formatMoney.
function balanceText(balance) {
  const money = formatMoney(balance.amount, '');
  if (money === null) return '';
  const currency = typeof balance.currency === 'string' ? balance.currency.trim() : '';
  return currency ? `${textCell(money)} ${textCell(currency)}` : textCell(money);
}

// One condensed row per measurement. The WINDOW column carries the basis
// (a token window reads "Tokens", a balance reads "Balance"), so the
// condensed layout needs no separate basis suffix.
//
// Every route gets at least one row: a route with no measurement at all
// (an unknown state, no windows, no balance) still appears, with the state
// in the STATE column and an empty measurement. The condensed view lists the
// SAME routes as the expanded one — a route missing here would be missing
// from the report.
function condensedRows(route) {
  const rows = [];
  const known = isKnownState(route.state);
  for (const w of route.windows) {
    const typeLabel = textCell(windowLabel(w.type));
    if (known && w.remainingRatio !== null) {
      rows.push({
        window: typeLabel,
        remaining: barFor(w.remainingRatio),
        left: textCell(pctLabel(w.remainingRatio)),
      });
    } else {
      // An unknown or stale window: no bar. The raw counts are shown when
      // they are known; otherwise the known percentage is shown, so the
      // measurement never disappears from the text.
      const text = countsText(w, true);
      if (text) {
        rows.push({ window: typeLabel, remaining: text, left: '' });
      } else if (w.remainingRatio !== null) {
        rows.push({ window: typeLabel, remaining: '', left: textCell(pctLabel(w.remainingRatio)) });
      }
    }
  }
  if (route.balance && route.balance.amount !== null) {
    rows.push({
      window: 'Balance',
      remaining: balanceText(route.balance),
      left: '',
    });
  }
  if (!rows.length) rows.push({ window: '', remaining: '', left: '' });
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
  return `${textCell(counts.healthy)} healthy | ${textCell(counts.constrained)} constrained | ${textCell(counts.exhausted)} exhausted | ${textCell(counts.unknown)} unknown`;
}

// Issue #103 — the view header.
//
// The ascii.rest "View-Limits" banner as STATIC PLAIN TEXT: 8 lines, no ANSI,
// no escape bytes. It is the header of the full text layout everywhere the
// live banner cannot be drawn — a pipe or a capture, NO_COLOR, TERM=dumb, or
// a dependency that is not installed — so the header never depends on the
// dependency being present.
//
// These 8 lines ARE the package's resting frame: generated once from
// ascii.rest 0.4.0 — the still frame of the same text, font and shadow,
// trimmed of its trailing padding, which is exactly what the terminal
// banner prints (print.js trims every row the same way). The fallback is
// therefore the same picture as the live banner, not a transcription of it.
//
// The live banner is drawn by bin/vl.js, which loads the dependency itself
// (a dynamic import, on a terminal only). Nothing in lib/ imports it.
//
// (ascii.rest — MIT, Copyright 2026 bas3line. https://ascii.rest)
const STATIC_BANNER = Object.freeze([
  '▓┓  ▓┓ ▓▓▓┓ ▓▓▓▓▓┓ ▓┓  ▓┓       ▓┓     ▓▓▓┓ ▓┓  ▓┓ ▓▓▓┓ ▓▓▓▓▓┓  ▓▓▓┓',
  '▓┃  ▓┃ ┗▓┏┛ ▓┏━━━┛ ▓┃  ▓┃       ▓┃     ┗▓┏┛ ▓▓┓▓▓┃ ┗▓┏┛ ┗━▓┏━┛ ▓┏━━▓┓',
  '▓┃  ▓┃  ▓┃  ▓┃     ▓┃  ▓┃       ▓┃      ▓┃  ▓┏▓┏▓┃  ▓┃    ▓┃   ▓┃  ┗┛',
  '▓┃  ▓┃  ▓┃  ▓▓▓▓┓  ▓┃▓┓▓┃ ▓▓▓▓┓ ▓┃      ▓┃  ▓┃▓┃▓┃  ▓┃    ▓┃   ┗▓▓▓┓',
  '▓┃  ▓┃  ▓┃  ▓┏━━┛  ▓┃▓┃▓┃ ┗━━━┛ ▓┃      ▓┃  ▓┃┗┛▓┃  ▓┃    ▓┃    ┗━━▓┓',
  '┗▓┓▓┏┛  ▓┃  ▓┃     ▓▓┏▓▓┃       ▓┃      ▓┃  ▓┃  ▓┃  ▓┃    ▓┃   ▓┓  ▓┃',
  ' ┗▓┏┛  ▓▓▓┓ ▓▓▓▓▓┓ ▓┏┛┗▓┃       ▓▓▓▓▓┓ ▓▓▓┓ ▓┃  ▓┃ ▓▓▓┓   ▓┃   ┗▓▓▓┏┛',
  '  ┗┛   ┗━━┛ ┗━━━━┛ ┗┛  ┗┛       ┗━━━━┛ ┗━━┛ ┗┛  ┗┛ ┗━━┛   ┗┛    ┗━━┛',
]);

// The header lines of the full text layout. `opts.header` wins when it is an
// array: the caller that drew the live banner passes the lines it printed,
// or an empty array when it printed them itself, above this text.
function headerLines(opts) {
  if (Array.isArray(opts.header)) return opts.header;
  return STATIC_BANNER;
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
        const provider = index === 0 ? textCell(route.label || route.id) : '';
        const state = index === 0 ? String(route.state || 'unknown').toUpperCase() : '';
        lines.push(trimEnd(
          `${textCell(provider).padEnd(15)}${textCell(cells.window).padEnd(9)}${textCell(cells.remaining).padEnd(25)}${textCell(cells.left).padStart(4)}  ${textCell(state)}`,
        ));
      });
    }
    return lines;
  }

  // Issue #103: the header is the banner — the static one by default, the
  // caller's own lines when the live banner was drawn above this text.
  for (const line of headerLines(opts)) lines.push(line);
  lines.push('');
  lines.push('QUOTA REMAINING');
  lines.push('');
  for (const route of routes) {
    lines.push(
      `${textCell(route.label || route.id).padEnd(49)}${textCell(route.state || 'unknown').toUpperCase().padEnd(13)}${textCell(route.freshness || 'unknown').toUpperCase()}`,
    );
    for (const row of expandedRows(route, ctx)) {
      lines.push(`  ${textCell(row.label).padEnd(9)}${textCell(row.value)}`);
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
  // Issue #103 — the static banner header.
  STATIC_BANNER,
  escapeControlChars,
  validateReauthUrl,
  VIEW_REASON_CODES,
  // Issue #60 — the collection block.
  COLLECTION_OUTCOMES,
  ROUTE_COLLECTION_OUTCOMES,
  buildCollectionBlock,
};