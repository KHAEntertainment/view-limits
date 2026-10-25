'use strict';
// The dashboard page's browser side (Issue #62): poll the daemon, render, and
// ask for a refresh. The rendering itself is ./render.js (pure).
//
// Every value reaches the DOM through textContent or setAttribute, never an
// HTML-string sink, and a link's href is re-validated (https only) right here, so a
// provider or config string can never become markup or a script URL.
(function () {
  const L = window.VLPageLogic;
  const R = window.VLPageRender;
  const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  };

  // The mode is set by the server. `lan-preview` is a layout preview on
  // loopback: the server leaves the refresh token out of that page.
  const mode = meta('vl-mode') === 'local' ? 'local' : 'lan';
  const threshold = L.parseThreshold(meta('vl-threshold'));
  const refreshToken = mode === 'local' ? meta('vl-refresh-token') : null;
  const narrowQuery = window.matchMedia('(max-width: 520px)');

  const state = {
    doc: null,
    fetchFailed: false,
    expanded: new Set(),
    refresh: { busy: false, message: null, error: false },
  };
  let pollTimer = null;
  let noteTimer = null;

  const ATTRS = new Set(['class', 'id', 'role', 'title', 'type', 'target', 'rel', 'disabled', 'scope']);
  function materialize(node) {
    if (typeof node === 'string') return document.createTextNode(node);
    const el = document.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined) continue;
      if (name === 'on') {
        for (const [event, fn] of Object.entries(value)) el.addEventListener(event, fn);
      } else if (name === 'style') {
        for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, String(v));
      } else if (name === 'href') {
        const safe = L.safeHttpsUrl(value);
        if (safe) el.setAttribute('href', safe);
      } else if (ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-')) {
        el.setAttribute(name, String(value));
      }
    }
    for (const child of node.children) el.appendChild(materialize(child));
    return el;
  }

  function render() {
    const root = document.getElementById('app');
    const focused = document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-key') : null;
    const tree = R.renderPage(state.doc, {
      mode,
      narrow: narrowQuery.matches,
      now: Date.now(),
      threshold,
      fetchFailed: state.fetchFailed,
      expanded: state.expanded,
      refresh: state.refresh,
      on: { refresh: requestRefresh, toggle },
    });
    root.replaceChildren(materialize(tree));
    if (focused) {
      const again = root.querySelector(`[data-key="${CSS.escape(focused)}"]`);
      if (again) again.focus();
    }
  }

  function toggle(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    render();
  }

  // Keep the relative times current between polls without rebuilding the DOM.
  function tick() {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-rel]')) {
      const kind = el.getAttribute('data-rel');
      let text = null;
      if (kind === 'ago') text = L.formatAgo(el.getAttribute('data-at'), now);
      else if (kind === 'reset') text = L.formatReset(el.getAttribute('data-at'), now);
      else if (kind === 'next') {
        const ms = L.nextCheckIn(state.doc, now);
        text = ms === null ? null : L.formatDuration(ms);
      }
      if (text !== null && el.textContent !== text) el.textContent = text;
    }
  }

  // GET /api/status is observation-only on the daemon: polling it never
  // triggers a provider read.
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const res = await fetch('/api/status', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      state.doc = await res.json();
      state.fetchFailed = false;
    } catch (e) {
      state.fetchFailed = true;
    }
    render();
    pollTimer = setTimeout(poll, state.fetchFailed ? 10000 : L.pollDelayMs(state.doc));
  }

  function note(message, isError) {
    state.refresh.message = message;
    state.refresh.error = !!isError;
    clearTimeout(noteTimer);
    if (message && !isError) noteTimer = setTimeout(() => { state.refresh.message = null; render(); }, 6000);
  }

  // POST /api/refresh with the page's refresh token. The daemon either starts
  // a collection or joins the one in flight (coalesced); the poll then follows
  // the collection at a short interval until it is idle.
  async function requestRefresh() {
    if (mode !== 'local' || !refreshToken || state.refresh.busy) return;
    state.refresh.busy = true;
    note(null);
    render();
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-VL-Nonce': refreshToken },
        body: '{}',
      });
      if (res.status === 202) {
        const body = await res.json().catch(() => ({}));
        note(body && body.coalesced ? 'Joined the check already running.' : 'Check started.');
      } else if (res.status === 401) {
        note('Refresh refused: this page is from an earlier daemon. Reload the page.', true);
      } else {
        note(`Refresh failed (HTTP ${res.status}).`, true);
      }
    } catch (e) {
      note('Refresh failed: the daemon is not answering.', true);
    }
    state.refresh.busy = false;
    poll();
  }

  narrowQuery.addEventListener('change', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setInterval(tick, 1000);
  poll();
}());
