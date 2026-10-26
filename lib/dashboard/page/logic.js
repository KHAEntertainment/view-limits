'use strict';
// The dashboard page's pure logic (Issue #62). No DOM, no I/O: the browser
// loads it as a plain script (global `VLPageLogic`), and the tests require it.
//
// Everything here reads the view schema's structured fields only (lib/view-model.js
// #buildViewSchema). Nothing parses the CLI's text lines.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VLPageLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // The gate's own default (lib/config.js gate.constrainedThreshold). The page
  // normally receives the configured value from the daemon in a <meta>; this
  // is only the fallback when that value is absent or malformed.
  const DEFAULT_THRESHOLD = 0.2;

  const STATES = ['healthy', 'constrained', 'exhausted', 'unknown'];

  // A1: the provider's own console, from a FIXED table keyed by the built-in
  // provider id. The URL is never read from provider responses or config, so
  // no injected value can become a link. Recipe routes (custom endpoints, and
  // the Alibaba / StepFun recipes) get no button. The owner verified each page.
  const PROVIDER_DASHBOARDS = Object.freeze({
    xiaomi: 'https://platform.xiaomimimo.com/console/plan-manage',
    minimax: 'https://platform.minimax.io/console/usage',
    kimi: 'https://www.kimi.ai/code/console',
    openrouter: 'https://openrouter.ai/settings/credits',
    deepseek: 'https://platform.deepseek.com/usage',
    glm: 'https://z.ai/manage-apikey/coding-plan/personal/usage',
  });

  // The built-in recipes (lib/view-model.js RECIPE_NAMES). A route with any
  // other recipe is a user-defined custom route.
  const BUILTIN_RECIPES = Object.freeze(['alibaba-coding-plan', 'stepfun-plan']);

  const WINDOW_LABELS = Object.freeze({
    'rolling-5h': '5 hour',
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    credit: 'Quota',
    concurrency: 'Concurrency',
    tokens: 'Tokens',
  });

  const WINDOW_SHORT = Object.freeze({
    'rolling-5h': '5 h',
    daily: 'day',
    weekly: 'wk',
    monthly: 'mo',
  });

  // The view's reason codes in plain words. The vocabulary is fixed
  // (VIEW_REASON_CODES): a code not on this list is not shown. `null` means
  // the code is already said elsewhere on the card (the chip, the reauth box).
  const REASON_WORDS = Object.freeze({
    'no-cached-observation': 'no observation yet',
    'cached-state-absent': 'no state reported',
    'cached-field-absent': 'field missing',
    'stale-observation': 'stale observation',
    'config-revision-obsolete': 'config changed',
    'state-unknown': null,
    'no-fresh-observation': null,
    'fresh-exhausted': null,
    'window-unit-unavailable': null,
    'reauth-required': 'login expired',
    'reauth-url-invalid': 'login link rejected',
    'no-routes-configured': 'no routes configured',
    'no-observed-state': 'no observed state',
    'config-inconclusive': 'config unreadable',
    'config-corrupt': 'config corrupt',
    'config-absent': 'no config',
    'invalid-state': 'invalid state',
    'invalid-basis': 'invalid basis',
    'no-native-facts': 'no native facts',
    'native-unavailable': 'native limits unavailable',
    'freshness-unproven': 'freshness unproven',
    'collection-failed': 'collection failed',
    'collection-pending': null,
  });

  // Issue #120 — the built-in refusal reason words. These are NOT part of the
  // reason-code vocabulary (REASON_WORDS): a refusal rides in the dedicated
  // additive `refusal` block, never in reasonCodes, so the LAN allowlist stays
  // untouched (C-003).
  const REFUSAL_WORDS = Object.freeze({
    'built-in-endpoint-refused': 'endpoint refused',
    'unknown-region': 'unknown region',
  });

  function own(map, key) {
    return typeof key === 'string' && key && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function codesOf(route) { return route && Array.isArray(route.reasonCodes) ? route.reasonCodes : []; }

  // The threshold the daemon put in the page, or the gate's default.
  function parseThreshold(text) {
    const n = typeof text === 'string' && /^\d*\.?\d+$/.test(text.trim()) ? Number(text) : NaN;
    return n > 0 && n < 1 ? n : DEFAULT_THRESHOLD;
  }

  // M2-A: each bar is coloured by its OWN window. 0% left = exhausted, under
  // the threshold = constrained, otherwise healthy. No ratio, no level.
  function barLevel(ratio, threshold) {
    if (!isNum(ratio)) return null;
    const t = isNum(threshold) && threshold > 0 && threshold < 1 ? threshold : DEFAULT_THRESHOLD;
    if (ratio <= 0) return 'exhausted';
    if (ratio < t) return 'constrained';
    return 'healthy';
  }

  function isCustomRoute(route) {
    const recipe = route && typeof route.recipe === 'string' && route.recipe ? route.recipe : null;
    return recipe !== null && !BUILTIN_RECIPES.includes(recipe);
  }

  // A1: the fixed console URL for a built-in provider, or null. A route with a
  // recipe (custom or built-in recipe) never gets one.
  function dashboardUrlFor(route) {
    if (!route || (typeof route.recipe === 'string' && route.recipe)) return null;
    return own(PROVIDER_DASHBOARDS, route.provider);
  }

  // The same rules the schema applies to reauth.url (lib/view-model.js
  // #validateReauthUrl), re-checked here before anything becomes a link: https
  // only, no userinfo, no query, no control characters, whitespace or backslash.
  function safeHttpsUrl(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text || /[\u0000-\u001f\u007f-\u009f\s\\]/.test(text)) return null;
    let parsed;
    try { parsed = new URL(text); } catch (e) { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search) return null;
    return text;
  }

  function needsReauth(route) { return !!(route && route.reauth && typeof route.reauth === 'object'); }
  function collectionFailed(route) { return codesOf(route).includes('collection-failed'); }

  // The state the page shows. The schema's four states, plus `pending` for a
  // route whose first collection is still running and has never been
  // observed. Pending, like unknown, is never shown as healthy.
  function displayState(route) {
    const state = route && STATES.includes(route.state) ? route.state : 'unknown';
    if (state === 'unknown' && codesOf(route).includes('collection-pending') && !route.observedAt) return 'pending';
    return state;
  }

  // A2: the re-login copy. The LAN view never carries a link; the local view
  // shows the validated https URL with the profile hint.
  function reauthCopy(route, mode) {
    if (!needsReauth(route)) return null;
    if (mode !== 'local') return { text: 'Login expired: log in again on your Mac', url: null, profile: null };
    const url = safeHttpsUrl(route.reauth.url);
    const profile = typeof route.reauth.profile === 'string' && route.reauth.profile ? route.reauth.profile : null;
    if (!url) return { text: 'Login expired: the login link failed validation, so none is shown', url: null, profile };
    return { text: 'Log in again', url, profile };
  }

  function tightestWindow(route) {
    let best = null;
    for (const w of route && Array.isArray(route.windows) ? route.windows : []) {
      if (w && isNum(w.remainingRatio) && (best === null || w.remainingRatio < best.remainingRatio)) best = w;
    }
    return best;
  }

  function earliestReset(windows) {
    let best = null;
    for (const w of windows) {
      const t = w && typeof w.resetAt === 'string' ? Date.parse(w.resetAt) : NaN;
      if (Number.isFinite(t) && (best === null || t < best.t)) best = { t, iso: w.resetAt };
    }
    return best ? best.iso : null;
  }

  // The needs-attention strip: exhausted, login expired, collection failed.
  // One item per route (login first: it is the one the user can act on), then
  // configuration order within each kind.
  const ATTENTION_ORDER = ['reauth', 'exhausted', 'failed'];
  function attentionItems(view) {
    const items = [];
    const routes = view && Array.isArray(view.routes) ? view.routes : [];
    routes.forEach((route, index) => {
      let kind = null;
      if (needsReauth(route)) kind = 'reauth';
      else if (route.state === 'exhausted') kind = 'exhausted';
      else if (collectionFailed(route)) kind = 'failed';
      if (!kind) return;
      const windows = Array.isArray(route.windows) ? route.windows : [];
      const spent = windows.filter((w) => w && isNum(w.remainingRatio) && w.remainingRatio <= 0);
      items.push({ route, kind, index, resetAt: kind === 'exhausted' ? earliestReset(spent.length ? spent : windows) : null });
    });
    items.sort((a, b) => (ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind)) || (a.index - b.index));
    return items;
  }

  function reasonChips(route) {
    const out = [];
    for (const code of codesOf(route)) {
      const word = own(REASON_WORDS, code);
      if (word && !out.includes(word)) out.push(word);
    }
    return out;
  }

  // The chip word for a refusal reason (Issue #120). Only the two known codes
  // map to a word; anything else is not rendered as a refusal.
  function refusalWord(reason) {
    return own(REFUSAL_WORDS, reason);
  }

  function windowLabel(type) {
    return own(WINDOW_LABELS, type) || (typeof type === 'string' && type ? type : 'Quota');
  }
  function windowShort(type) { return own(WINDOW_SHORT, type) || windowLabel(type); }

  // ---- formatting -----------------------------------------------------------
  // PROVISIONAL: relative times as in the wireframe ("12 s ago", "in 2 h 40 m").
  // The owner's Stitch edit to the time display is not visible to us.

  function formatDuration(ms) {
    if (!isNum(ms)) return null;
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
  }

  function formatAgo(iso, now) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return null;
    return `${formatDuration(Math.max(0, now - t))} ago`;
  }

  // A reset within a day is relative; a later one is a weekday and a time.
  function formatReset(iso, now) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return null;
    const ms = t - now;
    if (ms <= 0) return 'now';
    if (ms < 24 * 3600 * 1000) return `in ${formatDuration(ms)}`;
    try {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date(t)).replace(',', '');
    } catch (e) {
      return `in ${formatDuration(ms)}`;
    }
  }

  function formatPct(ratio) { return isNum(ratio) ? `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` : null; }

  function formatCount(n) {
    if (!isNum(n)) return null;
    try { return n.toLocaleString('en-US'); } catch (e) { return String(n); }
  }

  // A null amount is absent, never 0.00. A currency that is not a plain ISO
  // code is shown as text beside the number, not handed to Intl.
  function formatMoney(amount, currency) {
    if (!isNum(amount)) return null;
    if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) {
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(amount);
      } catch (e) { /* fall through */ }
    }
    const text = amount.toFixed(2);
    return typeof currency === 'string' && currency ? `${text} ${currency}` : text;
  }

  // "412 / 1,000", or "41% left", for a window shown as text (unknown state).
  function countsText(w) {
    if (!w) return null;
    if (isNum(w.remaining) && isNum(w.limit)) return `${formatCount(w.remaining)} / ${formatCount(w.limit)}`;
    if (isNum(w.remainingRatio)) return `${formatPct(w.remainingRatio)} left`;
    return null;
  }

  // The header's status, from the daemon's /api/status document. A failed
  // poll is `disconnected`; nothing but `ok` is ever presented as healthy.
  const HEADER_TONES = Object.freeze({ ok: 'healthy', pending: 'unknown', stale: 'constrained', unavailable: 'exhausted', disconnected: 'exhausted' });
  function headerStatus(doc, fetchFailed) {
    if (fetchFailed) return { label: 'disconnected', tone: 'exhausted' };
    const s = doc && typeof doc.status === 'string' && own(HEADER_TONES, doc.status) ? doc.status : 'unavailable';
    return { label: s, tone: HEADER_TONES[s] };
  }

  // When the next scheduled check is due. The scheduler ticks every interval
  // from the daemon's start; a manual refresh does not move the ticks.
  function nextCheckIn(doc, now) {
    const d = doc && doc.daemon;
    const start = d && typeof d.startedAt === 'string' ? Date.parse(d.startedAt) : NaN;
    const every = d && isNum(d.intervalSeconds) && d.intervalSeconds > 0 ? d.intervalSeconds * 1000 : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(every) || now < start) return null;
    return every - ((now - start) % every);
  }

  function pollDelayMs(doc) {
    const d = doc && doc.daemon;
    if (doc && doc.collection && doc.collection.state === 'collecting') return 2000;
    return d && isNum(d.intervalSeconds) && d.intervalSeconds > 0 ? d.intervalSeconds * 1000 : 30000;
  }

  return {
    DEFAULT_THRESHOLD, PROVIDER_DASHBOARDS, REASON_WORDS, REFUSAL_WORDS,
    parseThreshold, barLevel, isCustomRoute, dashboardUrlFor, safeHttpsUrl,
    needsReauth, collectionFailed, displayState, reauthCopy, tightestWindow,
    attentionItems, reasonChips, windowLabel, windowShort,
    refusalWord,
    formatDuration, formatAgo, formatReset, formatPct, formatCount, formatMoney, countsText,
    headerStatus, nextCheckIn, pollDelayMs,
  };
}));
