'use strict';
// Strict parsers for documented rate-limit response headers. Pure: headers
// (lower-cased names → string values) + `now` in, windows or a stable error
// code out. No partial credit: one malformed, partial or contradictory signal
// makes the whole observation unusable, because a half-read header set cannot
// say which pool is exhausted.
//
//   { windows: [{ type, remaining, limit, resetAt }], error: null }
//   { windows: [], error: '<stable reason>' }
//
// Throughput headers describe request/token rate limits, not subscription
// credits; callers label them `signal: 'throughput'` and never treat them as
// a plan balance.

// OpenAI documents `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`.
const OPENAI_KINDS = ['requests', 'tokens'];
// Anthropic documents `anthropic-ratelimit-<kind>-{limit,remaining,reset}`.
const ANTHROPIC_KINDS = ['requests', 'tokens', 'input-tokens', 'output-tokens'];

const MAX_RESET_MS = 31 * 24 * 3600 * 1000; // a rate-limit window longer than a month is not credible
const INT_RE = /^\d{1,15}$/;
// OpenAI relative duration: ordered h, m, s, ms units, e.g. "1h2m3.5s", "6m0s", "20ms".
const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EPOCH_SECONDS_RE = /^\d{9,11}$/;

// Relative duration → milliseconds, or NaN.
function parseDuration(text) {
  if (typeof text !== 'string' || !text) return NaN;
  const m = DURATION_RE.exec(text);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return NaN;
  const ms = (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000 + Number(m[4] || 0);
  return Number.isFinite(ms) && ms <= MAX_RESET_MS ? ms : NaN;
}

// Reset header → ISO instant, or null when it does not match `encoding`.
//   duration       relative to `now`
//   epoch-seconds  absolute
//   rfc3339        absolute
// Absolute instants further than MAX_RESET_MS from `now` are rejected.
function parseReset(text, encoding, now) {
  if (typeof text !== 'string') return null;
  let t;
  if (encoding === 'duration') {
    const ms = parseDuration(text);
    if (!Number.isFinite(ms)) return null;
    t = now + ms;
  } else if (encoding === 'epoch-seconds') {
    if (!EPOCH_SECONDS_RE.test(text)) return null;
    t = Number(text) * 1000;
  } else if (encoding === 'rfc3339') {
    if (!RFC3339_RE.test(text)) return null;
    t = Date.parse(text);
  } else {
    return null;
  }
  if (!Number.isFinite(t) || Math.abs(t - now) > MAX_RESET_MS) return null;
  return new Date(t).toISOString();
}

function parseKinds(headers, kinds, nameOf, encoding, now) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const windows = [];
  for (const kind of kinds) {
    const names = { limit: nameOf(kind, 'limit'), remaining: nameOf(kind, 'remaining'), reset: nameOf(kind, 'reset') };
    const raw = { limit: h[names.limit], remaining: h[names.remaining], reset: h[names.reset] };
    const present = Object.values(raw).filter((v) => v !== undefined).length;
    if (!present) continue;
    // limit + remaining are both required once any part of the triplet
    // appears; a lone remaining has no denominator and a lone reset says
    // nothing about headroom.
    if (raw.limit === undefined || raw.remaining === undefined) {
      return { windows: [], error: `partial-ratelimit:${kind}` };
    }
    for (const part of ['limit', 'remaining']) {
      if (!INT_RE.test(raw[part])) return { windows: [], error: `malformed-ratelimit-header:${names[part]}` };
    }
    const limit = Number(raw.limit);
    const remaining = Number(raw.remaining);
    if (limit <= 0 || remaining > limit) return { windows: [], error: `contradictory-ratelimit:${kind}` };
    let resetAt = null;
    if (raw.reset !== undefined) {
      resetAt = parseReset(raw.reset, encoding, now);
      if (!resetAt) return { windows: [], error: `malformed-ratelimit-header:${names.reset}` };
    }
    windows.push({ type: kind, remaining, limit, resetAt });
  }
  if (!windows.length) return { windows: [], error: 'no-ratelimit-signal' };
  return { windows, error: null };
}

function parseOpenAIHeaders(headers, encoding, now = Date.now()) {
  return parseKinds(headers, OPENAI_KINDS, (kind, part) => `x-ratelimit-${part}-${kind}`, encoding, now);
}

// Anthropic resets are always RFC 3339.
function parseAnthropicHeaders(headers, now = Date.now()) {
  return parseKinds(headers, ANTHROPIC_KINDS, (kind, part) => `anthropic-ratelimit-${kind}-${part}`, 'rfc3339', now);
}

module.exports = { parseOpenAIHeaders, parseAnthropicHeaders, parseDuration, parseReset, MAX_RESET_MS };
