'use strict';
// The dashboard page's renderer (Issue #62): status document → a tree of plain
// node descriptions. Pure: no DOM, no I/O, so the tests can render a hostile
// document without a browser. ./app.js turns the tree into DOM with
// createElement / textContent / setAttribute only — never an HTML-string sink.
//
// Node shape: { tag, attrs, children } where every child is a node or a
// string (always set as text). `attrs.style` holds CSSOM properties (the CSP
// forbids style attributes), `attrs.on` holds event handlers.
//
// Modes:
//   local        the loopback page: refresh, dashboard buttons, re-login links.
//   lan          the phone/LAN view: no controls, no links, no identifiers.
//                Served by the LAN listener (./lan-server), the data is
//                already redacted on the server (./lan-redact); hiding UI is
//                never the redaction. With `ctx.preview` it is the loopback
//                preview (/?view=lan) of the same layout over the full data.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic'));
  else root.VLPageRender = factory(root.VLPageLogic);
}(typeof self !== 'undefined' ? self : this, function (L) {
  function h(tag, attrs, ...children) {
    const flat = [];
    (function add(list) {
      for (const c of list) {
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) add(c);
        else flat.push(typeof c === 'object' ? c : String(c));
      }
    }(children));
    return { tag, attrs: attrs || {}, children: flat };
  }

  const GLYPHS = { healthy: '✓', constrained: '!', exhausted: '✕', unknown: '?', pending: '…' };

  // A relative time the page keeps current between polls (./app.js ticks it).
  function rel(kind, iso, text) {
    return h('span', { class: 'mono', 'data-rel': kind, 'data-at': iso }, text);
  }

  function chip(text, tone, extra) {
    return h('span', { class: `chip${tone ? ` tone-${tone}` : ''}${extra ? ` ${extra}` : ''}` }, text);
  }

  // `key` lets ./app.js put keyboard focus back on the same link after a
  // poll re-renders the page.
  function externalLink(url, cls, children, label, key) {
    const safe = L.safeHttpsUrl(url);
    if (!safe) return null;
    return h('a', { class: cls, href: safe, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, 'data-key': key || null }, children);
  }

  function skeleton(widthClass) { return h('div', { class: `skeleton ${widthClass || ''}`, 'aria-hidden': 'true' }); }

  // A "A · B · C" line that may wrap. The separator belongs to the segment it
  // precedes and sits in a clipped gutter, so a wrapped line never ends (or
  // starts) with a stray "·". Each part is a node, a string, or a list.
  function segs(parts, cls) {
    const items = parts.filter((p) => p !== null && p !== undefined && p !== false);
    return h('span', { class: `segs${cls ? ` ${cls}` : ''}` },
      h('span', { class: 'segs-in' }, items.map((p) => (p && p.seg ? h('span', { class: `seg ${p.seg}` }, p.part) : h('span', { class: 'seg' }, p)))));
  }

  // ---- one route -----------------------------------------------------------

  function windowRow(w, route, ctx) {
    const label = L.windowLabel(w.type);
    if (route.state === 'unknown') {
      // No bar for an unknown state: the raw counts, as the CLI does.
      const counts = L.countsText(w);
      if (!counts) return null;
      return h('div', { class: 'kv' },
        h('span', { class: 'k' }, label),
        h('span', { class: 'v mono' }, counts,
          route.observedAt ? [' (last seen ', rel('ago', route.observedAt, L.formatAgo(route.observedAt, ctx.now)), ')'] : null));
    }
    const level = L.barLevel(w.remainingRatio, ctx.threshold);
    if (!level) {
      return h('div', { class: 'kv' }, h('span', { class: 'k' }, label), h('span', { class: 'v mono' }, L.countsText(w) || '—'));
    }
    const pct = L.formatPct(w.remainingRatio);
    return h('div', { class: 'win' },
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, label),
        h('span', { class: `v mono tone-text-${level}` }, `${pct} left`)),
      h('div', { class: 'track', role: 'img', 'aria-label': `${label}: ${pct} left, ${level}` },
        h('div', { class: `fill tone-bg-${level}`, style: { width: pct } })));
  }

  function resetsLine(route, ctx) {
    const parts = [];
    for (const w of Array.isArray(route.windows) ? route.windows : []) {
      if (!w || typeof w.resetAt !== 'string') continue;
      const when = L.formatReset(w.resetAt, ctx.now);
      if (when) parts.push([parts.length ? '' : 'Resets: ', `${L.windowLabel(w.type)} `, rel('reset', w.resetAt, when)]);
    }
    return parts.length ? h('div', { class: 'meta mono' }, segs(parts)) : null;
  }

  function balanceRows(route) {
    const b = route.balance;
    if (!b || typeof b !== 'object') return null;
    const amount = L.formatMoney(b.amount, b.currency);
    if (!amount) return null;
    const rows = [h('div', { class: 'kv balance' }, h('span', { class: 'k' }, 'Balance'), h('span', { class: 'v mono big' }, amount))];
    const s = b.spent;
    if (s && typeof s === 'object') {
      const spent = [['Today', s.daily], ['This week', s.weekly], ['This month', s.monthly]]
        .map(([k, v]) => { const m = L.formatMoney(v, b.currency); return m ? `${k} ${m}` : null; })
        .filter(Boolean);
      if (spent.length) rows.push(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Spent'), h('span', { class: 'v mono' }, spent.join(' · '))));
    }
    return rows;
  }

  function reauthBlock(route, ctx) {
    const copy = L.reauthCopy(route, ctx.mode);
    if (!copy) return null;
    if (!copy.url) return h('div', { class: 'reauth-box' }, copy.text);
    return [
      externalLink(copy.url, 'reauth', [
        h('span', null, `${copy.text} ↗`),
        copy.profile ? h('small', null, `(profile: ${copy.profile})`) : null,
      ], `${copy.text} (opens the provider's page in a new tab)`, `reauth:${ctx.narrow ? 'line' : 'card'}:${route.id}`),
      h('p', { class: 'hint' }, 'The next check picks up your new login.'),
    ];
  }

  function routeBody(route, ctx) {
    const state = L.displayState(route);
    const windows = Array.isArray(route.windows) ? route.windows : [];
    const out = [];
    if (state === 'pending' && !windows.length && !route.balance) {
      out.push(skeleton('w-full'), skeleton('w-3q'), h('div', { class: 'meta mono' }, 'Waiting for the first check…'));
      return out;
    }
    for (const w of windows) { if (w) out.push(windowRow(w, route, ctx)); }
    out.push(balanceRows(route));
    if (route.state !== 'unknown') out.push(resetsLine(route, ctx));
    const reasons = L.reasonChips(route).map((word) => chip(word, word === 'login expired' ? 'exhausted' : null, 'reason'));
    // The provider's own error text is a diagnostic: local view only, as text.
    if (ctx.mode === 'local' && typeof route.error === 'string' && route.error) {
      const short = route.error.length > 120 ? `${route.error.slice(0, 117)}…` : route.error;
      reasons.push(h('span', { class: 'chip reason', title: route.error }, short));
    }
    if (reasons.length) out.push(h('div', { class: 'reasons' }, reasons));
    out.push(reauthBlock(route, ctx));
    return out;
  }

  function routeFoot(route, ctx) {
    const parts = [];
    if (L.isCustomRoute(route)) parts.push('Custom route');
    if (route.observedAt) parts.push(['Observed ', rel('ago', route.observedAt, L.formatAgo(route.observedAt, ctx.now))]);
    else parts.push(L.displayState(route) === 'pending' ? 'Checking now' : 'Never checked');
    return h('div', { class: 'foot-meta mono' }, segs(parts));
  }

  function routeCard(route, ctx) {
    const state = L.displayState(route);
    const local = ctx.mode === 'local';
    const dash = local ? L.dashboardUrlFor(route) : null;
    return h('article', { class: 'card', 'data-route': route.id },
      h('header', { class: 'ch' },
        h('h3', { class: 't' }, route.label || route.id),
        chip(state, state, 'state'),
        local && route.quotaEligibility ? chip(route.quotaEligibility, null, 'elig') : null,
        h('span', { class: 'grow' }),
        // Q9: icon only, far right; "Dashboard" is a styled tooltip on hover
        // and keyboard focus. The accessible name says what it opens.
        dash ? externalLink(dash, 'dash icon-btn', [
          h('span', { class: 'ext-icon', 'aria-hidden': 'true' }),
          h('span', { class: 'tip', 'aria-hidden': 'true' }, 'Dashboard'),
        ], `Open ${route.label || route.id} dashboard`, `dash:${route.id}`) : null),
      routeBody(route, ctx),
      routeFoot(route, ctx));
  }

  // D3: one line per route in the narrow local pane; tapping expands it.
  function routeLine(route, ctx) {
    const state = L.displayState(route);
    const open = ctx.expanded.has(route.id);
    let mid;
    const tight = route.state !== 'unknown' ? L.tightestWindow(route) : null;
    if (state === 'pending') mid = [h('span', { class: 'mini-track' }), h('span', { class: 'muted mono' }, 'waiting…')];
    else if (L.needsReauth(route)) mid = h('span', { class: 'tone-text-constrained' }, 'login expired');
    else if (tight) {
      const level = L.barLevel(tight.remainingRatio, ctx.threshold);
      mid = [
        h('span', { class: 'mini-track' }, h('span', { class: `fill tone-bg-${level}`, style: { width: L.formatPct(tight.remainingRatio) } })),
        h('span', { class: `mono tone-text-${level}` }, L.formatPct(tight.remainingRatio)),
        h('span', { class: 'muted mono' }, ` · ${L.windowShort(tight.type)}`),
      ];
    } else if (route.balance && L.formatMoney(route.balance.amount, route.balance.currency)) {
      mid = h('span', { class: 'mono' }, L.formatMoney(route.balance.amount, route.balance.currency));
    } else if (L.collectionFailed(route)) mid = h('span', { class: 'muted' }, 'collection failed');
    else {
      const w = (route.windows || []).find((x) => L.countsText(x));
      mid = h('span', { class: 'muted mono' }, w ? L.countsText(w) : state);
    }
    const id = `line-${route.id}`;
    return h('div', { class: `line-item${open ? ' open' : ''}`, 'data-route': route.id },
      h('button', {
        class: 'line', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id,
        'data-key': `line:${route.id}`, on: { click: () => ctx.on.toggle(route.id) },
      },
      h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '⌄' : '›'),
      h('span', { class: 'n' }, route.label || route.id),
      h('span', { class: 'mid' }, mid),
      h('span', { class: `glyph tone-text-${state}`, title: state },
        h('span', { 'aria-hidden': 'true' }, GLYPHS[state] || '?'),
        h('span', { class: 'sr' }, state))),
      open ? h('div', { class: 'det', id }, routeBody(route, ctx), routeFoot(route, ctx)) : null);
  }

  // ---- page sections ---------------------------------------------------------

  function attentionStrip(view, ctx) {
    const items = L.attentionItems(view);
    if (!items.length) return null;
    return h('section', { class: 'attn', 'aria-label': 'Needs attention' },
      h('span', { class: 'attn-title' }, h('span', { class: 'attn-icon', 'aria-hidden': 'true' }, '!'), `Needs attention (${items.length})`),
      items.map((it) => {
        const name = it.route.label || it.route.id;
        if (it.kind === 'reauth') {
          const copy = L.reauthCopy(it.route, ctx.mode);
          return h('span', { class: 'attn-item' }, `${name}: login expired`,
            copy && copy.url ? externalLink(copy.url, 'attn-link mono', 'Log in again ↗', `Log in again to ${name} (opens in a new tab)`, `attn:${it.route.id}`) : null);
        }
        if (it.kind === 'exhausted') {
          const when = it.resetAt ? L.formatReset(it.resetAt, ctx.now) : null;
          return h('span', { class: 'attn-item' }, `${name}: exhausted`, when ? [' · resets ', rel('reset', it.resetAt, when)] : null);
        }
        return h('span', { class: 'attn-item' }, `${name}: collection failed`);
      }));
  }

  function profileState(p) { return typeof p.state === 'string' ? p.state : 'unknown'; }
  function profileWindow(p, ctx) {
    const w = Array.isArray(p.windows) ? p.windows.find((x) => x && x.type === 'rolling-5h') : null;
    if (!w || !Number.isFinite(w.remainingRatio)) return null;
    const reset = w.resetAt ? L.formatReset(w.resetAt, ctx.now) : null;
    return { pct: `${L.formatPct(w.remainingRatio)} left`, reset: reset ? ['resets ', rel('reset', w.resetAt, reset)] : null };
  }

  function profilesSection(view, ctx) {
    const profiles = Array.isArray(view.profiles) ? view.profiles : [];
    if (!profiles.length) return null;
    const title = h('h2', { class: 'section-title' }, 'Harness profiles');
    // D4: the LAN view shows harness + state only, no identifiers.
    if (ctx.mode !== 'local' || ctx.narrow) {
      return h('section', { class: 'profiles' }, title, h('ul', { class: 'plist' }, profiles.map((p) => {
        const state = profileState(p);
        const win = profileWindow(p, ctx);
        return h('li', null, h('span', { class: `dot tone-bg-${state}`, 'aria-hidden': 'true' }), segs([
          h('span', { class: 'mono' }, p.harness || 'harness'),
          h('span', { class: `tone-text-${state}` }, state),
          win ? h('span', { class: 'mono' }, `${win.pct} (5 hour)`) : null,
          win && win.reset ? h('span', { class: 'mono' }, win.reset) : null,
        ]));
      })));
    }
    const head = ['Harness', 'Profile', 'Host', '5 hour', 'State', 'Observed'];
    return h('section', { class: 'profiles' }, title, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, profiles.map((p) => {
        const id = p.identity || {};
        const state = profileState(p);
        const reasons = L.reasonChips(p);
        return h('tr', null,
          h('td', { class: 'mono' }, p.harness || '—'),
          h('td', { class: 'mono' }, id.profileId || '—'),
          h('td', { class: 'mono' }, id.host || '—'),
          h('td', { class: 'mono' }, (() => { const win = profileWindow(p, ctx); return win ? segs([win.pct, win.reset]) : '—'; })()),
          h('td', null, h('span', { class: `tone-text-${state}` }, state), reasons.length ? h('span', { class: 'muted' }, ` · ${reasons.join(' · ')}`) : null),
          h('td', { class: 'mono num' }, p.observedAt ? rel('ago', p.observedAt, L.formatAgo(p.observedAt, ctx.now)) : '—'));
      })))));
  }

  // When there is no route list to show yet.
  function emptyState(doc, ctx) {
    if (!doc) {
      if (ctx.fetchFailed) {
        return h('div', { class: 'empty' }, h('p', null, 'The dashboard daemon is not answering.'),
          h('p', { class: 'muted' }, 'Start it with ', h('code', null, 'vl.js dashboard start'), ', then reload this page.'));
      }
      return h('div', { class: 'empty' }, skeleton('w-full'), skeleton('w-3q'), h('p', { class: 'muted mono' }, 'Connecting to the daemon…'));
    }
    const view = doc.view;
    if (!view) {
      if (doc.status === 'pending') return h('div', { class: 'empty' }, skeleton('w-full'), h('p', { class: 'muted mono' }, 'Waiting for the first check…'));
      const a = doc.collection && doc.collection.lastAttempt;
      return h('div', { class: 'empty' },
        h('p', null, 'No status yet: the last check did not produce a view.'),
        a && typeof a.outcome === 'string' ? h('p', { class: 'muted mono' }, `Outcome: ${a.outcome}`) : null,
        ctx.mode === 'local' && a && typeof a.error === 'string' && a.error ? h('p', { class: 'muted mono' }, a.error) : null);
    }
    if (!Array.isArray(view.routes) || !view.routes.length) {
      return h('div', { class: 'empty' }, h('p', null, 'No routes are configured.'),
        h('p', { class: 'muted' }, 'Run ', h('code', null, '/view-limits:setup'), ' to add a provider.'));
    }
    return null;
  }

  function header(doc, ctx) {
    const status = L.headerStatus(doc, ctx.fetchFailed);
    const coll = doc && doc.collection;
    const fresh = [];
    if (coll && coll.lastGoodAt) fresh.push(['Updated ', rel('ago', coll.lastGoodAt, L.formatAgo(coll.lastGoodAt, ctx.now))]);
    else if (doc) fresh.push('Not updated yet');
    if (coll && coll.state === 'collecting') fresh.push('checking now…');
    else if (ctx.mode === 'local' && !ctx.narrow) {
      const next = L.nextCheckIn(doc, ctx.now);
      if (next !== null) fresh.push(['next check in ', h('span', { class: 'mono', 'data-rel': 'next' }, L.formatDuration(next))]);
    } else fresh.push('refreshes automatically');
    const attention = doc && doc.view ? L.attentionItems(doc.view).length : 0;
    // In the narrow pane the count never splits across lines (Q9 defect).
    if (ctx.narrow && attention) fresh.push({ seg: 'nowrap', part: h('span', { class: 'tone-text-constrained strong' }, `${attention} need${attention === 1 ? 's' : ''} attention`) });

    const pill = h('span', { class: `pill tone-${status.tone}`, role: 'status' },
      h('span', { class: `dot tone-bg-${status.tone}`, 'aria-hidden': 'true' }), status.label);
    const freshness = h('span', { class: 'fresh mono' }, segs(fresh));
    const local = ctx.mode === 'local';
    const r = ctx.refresh || {};
    const refreshBtn = local ? h('button', {
      class: `refresh${ctx.narrow ? ' icon' : ''}`, type: 'button', 'data-key': 'refresh',
      'aria-label': 'Refresh now', disabled: r.busy ? 'disabled' : null, on: { click: () => ctx.on.refresh() },
    }, h('span', { 'aria-hidden': 'true' }, '↻'), ctx.narrow ? null : (r.busy ? ' Refreshing…' : ' Refresh')) : null;
    const note = local && r.message ? h('span', { class: `refresh-note${r.error ? ' tone-text-exhausted' : ''}`, role: 'status' }, r.message) : null;

    if (ctx.narrow) {
      return h('header', { class: 'top narrow' },
        h('div', { class: 'top-row' }, h('span', { class: 'brand mono' }, 'view-limits'), pill, h('span', { class: 'grow' }), refreshBtn),
        h('div', { class: 'sub' }, freshness), note ? h('div', { class: 'sub' }, note) : null);
    }
    return h('header', { class: 'top' },
      h('span', { class: 'brand mono' }, 'view-limits'), pill, freshness, h('span', { class: 'grow' }), note,
      h('span', { class: 'badge mono' }, local ? 'Local view' : (ctx.preview ? 'LAN · read-only (preview)' : 'LAN · read-only')), refreshBtn);
  }

  function footer(doc, ctx) {
    const every = doc && doc.daemon && Number.isFinite(doc.daemon.intervalSeconds) ? `checks every ${doc.daemon.intervalSeconds} s` : null;
    const schema = doc && doc.view && doc.view.schemaVersion ? `Schema v${doc.view.schemaVersion}` : null;
    const parts = ctx.mode === 'local'
      ? [schema, every, "data: this machine's view-limits daemon", 'the page never contacts providers']
      : ['Read-only view', 'identifiers hidden on the network'];
    return h('footer', { class: 'foot mono' }, parts.filter(Boolean).join(' · '));
  }

  // The whole page. `ctx`: { mode, narrow, now, threshold, fetchFailed,
  // expanded: Set, refresh: { busy, message, error }, on: { refresh, toggle } }.
  // The LAN page without a usable read token (copy PROVISIONAL).
  function lanAuthState(kind) {
    return h('div', { class: 'empty' },
      h('p', null, kind === 'replaced' ? 'This link was replaced.' : 'Open the dashboard link from your Mac.'),
      h('p', { class: 'muted' }, 'On your Mac, run ', h('code', null, 'vl.js dashboard lan url'),
        kind === 'replaced' ? ' and open the new link on this device.' : ' and open that link on this device.'));
  }

  function renderPage(doc, ctx) {
    const lan = ctx.mode !== 'local';
    const cond = !lan && ctx.narrow;
    const view = ctx.lanAuth ? null : doc && doc.view;
    const empty = ctx.lanAuth ? lanAuthState(ctx.lanAuth) : emptyState(doc, ctx);
    let body;
    if (empty) body = empty;
    else if (cond) body = h('div', { class: 'lines' }, view.routes.map((r) => routeLine(r, ctx)));
    else body = [attentionStrip(view, ctx), h('div', { class: lan ? 'cards' : 'grid' }, view.routes.map((r) => routeCard(r, ctx)))];
    return h('div', { class: `page mode-${lan ? 'lan' : 'local'}${cond ? ' condensed' : ''}` },
      header(doc, ctx),
      lan && ctx.preview ? h('div', { class: 'preview-note' },
        'LAN preview, shown on this Mac only. ',
        'The real LAN view (vl.js dashboard lan enable) is redacted by the daemon before anything is sent; ',
        'this preview only hides fields in the page.') : null,
      h('main', { class: 'wrap' }, body, view && !empty ? profilesSection(view, ctx) : null),
      cond ? null : footer(doc, ctx));
  }

  return { h, renderPage, routeCard, routeLine, attentionStrip, GLYPHS };
}));
