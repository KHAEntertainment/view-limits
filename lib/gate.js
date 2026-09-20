'use strict';
// Pure dispatch-gate decision. No network, no filesystem, no Claude hook APIs —
// takes a resolved route + cached entry + clock, returns a decision.
//
// Tolerant of malformed inputs (null, primitives, arrays, bad timestamps,
// nested status fields of unexpected shape, calendar-overflow dates that
// Date.parse silently normalizes): any cache shape the consumer can't
// prove is fresh + exhausted fails open rather than deny. This protects
// against crashes and against false denies driven by a corrupt status
// file (CodeRabbit 4056155869: Date.parse('2030-09-31T...') rolls forward
// to Oct 1 2030 and would otherwise mark a stale entry as fresh).

function decide({ route, entry, now, config }) {
  if (!route) return { action: 'allow' };

  const fresh = isFreshEntry(entry, now);

  if (!entry || !fresh) {
    return {
      action: 'allow',
      refresh: true,
      context: `view-limits: no fresh status cached for "${route.id}" (model may be dispatched; refresh scheduled).`,
    };
  }

  const st = safeStatus(entry);
  if (st.state === 'exhausted') {
    const resetTs = safeIso(st.resetAt);
    const reset = resetTs ? ` Resets ${new Date(resetTs).toLocaleString()}.` : '';
    return {
      action: 'deny',
      reason: `view-limits: route "${route.id}" is exhausted. Dispatch blocked.${reset}`,
    };
  }

  // healthy / constrained / unknown → allow, inject a one-line status.
  return { action: 'allow', context: summarize(route, st) };
}

// True only when `entry` is a plain object with a strict ISO 8601 UTC
// freshUntil that hasn't expired. Anything else — null, primitives,
// arrays, malformed or normalized timestamps — is treated as not-fresh,
// so the gate falls through to the fail-open branch.
function isFreshEntry(entry, now) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.freshUntil !== 'string' || !entry.freshUntil) return false;
  const t = parseStrictIsoTimestamp(entry.freshUntil);
  if (t == null) return false;
  return now <= t;
}

// entry.status as a plain object, or {} — never an array, never a primitive.
function safeStatus(entry) {
  const st = entry && entry.status;
  if (!st || typeof st !== 'object' || Array.isArray(st)) return {};
  return st;
}

// Return `v` as a canonical ISO 8601 UTC string if it parses strictly;
// otherwise null. Defends the deny reason string from "Invalid Date" and
// from calendar-overflow normalization (CodeRabbit 4056155869).
function safeIso(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = parseStrictIsoTimestamp(v);
  return t == null ? null : new Date(t).toISOString();
}

// Parse a cache timestamp strictly:
//   * must be a non-empty ISO 8601 string `YYYY-MM-DDTHH:MM:SS[.fff]` with a
//     timezone designator — either `Z` (UTC) or `±HH:MM` / `±HHMM` (offset).
//     Valid offsets are accepted because the cache contract is the INSTANT,
//     not the textual form: a future schema or a manual cache edit may use
//     offsets and the gate must still deny when that instant is fresh +
//     exhausted. The current producer happens to write `Z` (canonical UTC)
//     because `toISOString()` is convenient, but the gate does not impose
//     a `Z`-only policy on its inputs.
//   * millisecond component is optional, 1–3 digits when present.
//   * calendar/time components are validated BEFORE `Date.parse`. Without
//     this guard, `Date.parse('2030-09-31T...')` silently normalizes to
//     Oct 1 2030 and would otherwise mark a corrupted entry as fresh +
//     future, producing a deny that the cache never actually claimed
//     (CodeRabbit 4056155869). The same silent normalization applies to
//     Feb 29 in non-leap years and month > 12.
// Returns the parsed epoch ms, or null when the input is not a valid
// ISO 8601 timestamp with a real calendar.
const STRICT_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

function isValidCalendar(y, mo, d, h, mi, s) {
  if (!Number.isInteger(y) || y < 1) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1) return false;
  if (h < 0 || h > 23) return false;
  if (mi < 0 || mi > 59) return false;
  if (s < 0 || s > 60) return false; // 60 permitted for leap seconds (lenient)
  const dim = mo === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[mo - 1];
  return d <= dim;
}

function parseStrictIsoTimestamp(s) {
  if (typeof s !== 'string' || !s) return null;
  const m = s.match(STRICT_ISO_RE);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const h = +m[4];
  const mi = +m[5];
  const sec = +m[6];
  // Calendar validation runs BEFORE Date.parse so a calendar-overflow
  // input is rejected before it can normalize into a different valid
  // instant (Sept 31 → Oct 1, Feb 29 non-leap → Mar 1, month 13 →
  // next January).
  if (!isValidCalendar(y, mo, d, h, mi, sec)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return t;
}

// Validate a single window shape: must be a non-null object with at least the
// fields the summary reads (`type`, `limit`, `remaining`). Anything else —
// null, primitive, array — is silently dropped so a corrupt window cannot
// crash the hook.
function safeWindow(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  return w;
}

// Validate that `windows` is an iterable array of valid window objects. A
// non-array (e.g. object used as a bag by a misbehaving adapter) becomes an
// empty list so `for (const w of windows)` never throws.
function safeWindows(windows) {
  if (!Array.isArray(windows)) return [];
  const out = [];
  for (const w of windows) {
    const sw = safeWindow(w);
    if (sw) out.push(sw);
  }
  return out;
}

// Validate balance: must be an object, and `available` must be defined to
// render. Otherwise omit the balance line.
function safeBalance(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  if (b.available == null) return null;
  return b;
}

function summarize(route, st) {
  const parts = [];
  const balance = safeBalance(st.balance);
  if (balance) parts.push(`balance ${balance.available} ${balance.currency || ''}`);
  for (const w of safeWindows(st.windows)) {
    if (w.limit && w.remaining != null) {
      const pct = w.limit > 0 ? Math.round((w.remaining / w.limit) * 100) : null;
      const label = w.type || 'window';
      parts.push(pct != null ? `${label} ${pct}%` : `${label} ${w.remaining}/${w.limit}`);
    }
  }
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  return `view-limits: ${route.id} → ${st.state}${suffix}`;
}

module.exports = { decide, summarize, parseStrictIsoTimestamp };
