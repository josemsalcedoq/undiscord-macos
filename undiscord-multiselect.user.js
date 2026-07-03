// ==UserScript==
// @name         Undiscord Multiselect
// @namespace    https://github.com/josemsalcedoq/undiscord-fork
// @version      0.1.0
// @description  Bulk-delete YOUR OWN Discord messages across DMs and servers, with checkbox multiselect discovery. Rate-limit engine ported from victornpb/undiscord.
// @author       josemsalcedoq
// @match        https://*.discord.com/*
// @match        https://discord.com/*
// @license      MIT
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * WARNING: This uses your own account token to delete your own messages, exactly
 * like the original Undiscord (https://github.com/victornpb/undiscord). Automating
 * a user account is against Discord's Terms of Service and can, in principle, get an
 * account actioned regardless of how slow you go. Use conservative delays. This is
 * for deleting YOUR OWN messages only.
 */

(function () {
  'use strict';

  const API = 'https://discord.com/api/v9';
  const PREFIX = '[undiscord-ms]';

  // ------------------------------------------------------------------ utils --
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const msToHMS = (ms) => {
    const s = Math.round(ms / 1000);
    return `${(s / 3600) | 0}h ${((s / 60) | 0) % 60}m ${s % 60}s`;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  // ------------------------------------------------- token / identity grabs --
  // Same technique the original Undiscord uses: read Discord's localStorage via a
  // throwaway iframe (Discord deletes `token` from the top window at runtime, but
  // it is still readable from a fresh same-origin iframe), with a webpack fallback.
  function getToken() {
    try {
      window.dispatchEvent(new Event('beforeunload'));
      const iframe = document.body.appendChild(document.createElement('iframe'));
      const LS = iframe.contentWindow.localStorage;
      const raw = LS.token;
      iframe.remove();
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn(PREFIX, 'iframe token grab failed, trying webpack', e);
    }
    try {
      let mods = [];
      window.webpackChunkdiscord_app.push([[Math.random()], {}, (e) => {
        for (const c in e.c) mods.push(e.c[c]);
      }]);
      const mod = mods.find((m) => m?.exports?.default?.getToken !== undefined);
      if (mod) return mod.exports.default.getToken();
    } catch (e) {
      console.warn(PREFIX, 'webpack token grab failed', e);
    }
    return null;
  }

  function getAuthorId(token) {
    // The user id is the first, base64-encoded segment of the token.
    try {
      const id = atob(token.split('.')[0]);
      if (/^\d+$/.test(id)) return id;
    } catch (_) {}
    try {
      const iframe = document.body.appendChild(document.createElement('iframe'));
      const cached = iframe.contentWindow.localStorage.user_id_cache;
      iframe.remove();
      if (cached) return JSON.parse(cached);
    } catch (_) {}
    return null;
  }

  // -------------------------------------------------- authed API GET helper --
  async function apiGet(path, token) {
    const res = await fetch(API + path, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  }

  // Discover DMs / group DMs and servers.
  async function discoverDMs(token) {
    const channels = await apiGet('/users/@me/channels', token);
    return channels
      .map((c) => {
        if (c.type === 1) {
          const r = c.recipients?.[0];
          return {
            kind: 'dm',
            channelId: c.id,
            label: r ? (r.global_name || r.username || r.id) : 'Unknown DM',
            sub: r?.username ? `@${r.username}` : '',
          };
        }
        if (c.type === 3) {
          const names = (c.recipients || []).map((r) => r.global_name || r.username).join(', ');
          return {
            kind: 'group',
            channelId: c.id,
            label: c.name || names || 'Group DM',
            sub: `group · ${(c.recipients || []).length + 1} people`,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  async function discoverGuilds(token) {
    const guilds = await apiGet('/users/@me/guilds', token);
    return guilds.map((g) => ({ kind: 'guild', guildId: g.id, label: g.name, sub: 'server' }));
  }

  // =====================================================================
  //  Deletion engine — rate-limit behaviour ported from victornpb/undiscord
  // =====================================================================
  class Engine {
    constructor() {
      this.options = {
        authToken: null,
        authorId: null,
        searchDelay: 30000, // ms between search pages (Undiscord default)
        deleteDelay: 1000, // ms between deletes (Undiscord default)
        includePinned: false,
        maxAttempt: 2,
      };
      this.state = this._freshState();
      this.stats = { throttledCount: 0, throttledTotalTime: 0, avgPing: 0, startTime: null };
      this.running = false;
      this.onProgress = null;
      this.onLog = null;
    }

    _freshState() {
      return { delCount: 0, failCount: 0, grandTotal: 0, offset: 0, _resp: null, _toDelete: [], _skipped: [] };
    }

    log(level, ...args) {
      if (this.onLog) this.onLog(level, args.join(' '));
      console.log(PREFIX, ...args);
    }

    stop() {
      this.running = false;
    }

    // Run a queue of targets: { label, channelId?, guildId }
    async runBatch(queue) {
      if (this.running) return this.log('error', 'Already running.');
      this.running = true;
      this.stats.startTime = Date.now();
      let grand = { del: 0, fail: 0 };
      this.log('info', `Starting batch of ${queue.length} target(s).`);

      for (let i = 0; i < queue.length && this.running; i++) {
        const job = queue[i];
        this.state = this._freshState();
        this.options.channelId = job.channelId || null;
        this.options.guildId = job.guildId;
        this.log('info', `\n[${i + 1}/${queue.length}] ${job.label}`);
        await this._runOne();
        grand.del += this.state.delCount;
        grand.fail += this.state.failCount;
      }

      this.running = false;
      this.log('success', `Batch finished. Deleted ${grand.del}, failed ${grand.fail}. Total time ${msToHMS(Date.now() - this.stats.startTime)}.`);
      if (this.onProgress) this.onProgress(grand.del, grand.del + grand.fail, 'done');
    }

    async _runOne() {
      do {
        await this._search();
        if (!this.running) break;
        this._filter();

        this.log('verb', `total≈${this.state.grandTotal} · page:${this.state._resp.messages.length} · toDelete:${this.state._toDelete.length} · skipped:${this.state._skipped.length} · offset:${this.state.offset}`);

        if (this.state._toDelete.length > 0) {
          await this._deleteList();
        } else if (this.state._skipped.length > 0) {
          // whole page non-deletable (system messages) -> advance past it
          this.state.offset += this.state._skipped.length;
          this.log('verb', `Nothing deletable on this page; advancing offset to ${this.state.offset}.`);
        } else {
          this.log('verb', 'Empty page — reached the end.');
          break;
        }

        this.log('verb', `Waiting ${(this.options.searchDelay / 1000).toFixed(1)}s before next page…`);
        await wait(this.options.searchDelay);
      } while (this.running);
    }

    _searchUrl() {
      const dm = !this.options.guildId || this.options.guildId === '@me';
      const base = dm
        ? `${API}/channels/${this.options.channelId}/messages/search`
        : `${API}/guilds/${this.options.guildId}/messages/search`;
      const p = new URLSearchParams();
      if (this.options.authorId) p.set('author_id', this.options.authorId);
      if (!dm && this.options.channelId) p.set('channel_id', this.options.channelId);
      p.set('sort_by', 'timestamp');
      p.set('sort_order', 'desc');
      p.set('offset', String(this.state.offset));
      return `${base}?${p.toString()}`;
    }

    async _search() {
      let resp;
      const t0 = Date.now();
      try {
        resp = await fetch(this._searchUrl(), { headers: { Authorization: this.options.authToken } });
      } catch (err) {
        this.running = false;
        this.log('error', 'Search request failed: ' + err.message);
        throw err;
      }
      this._ping(Date.now() - t0);

      // Channel not indexed yet.
      if (resp.status === 202) {
        let w = (await resp.json()).retry_after * 1000 || this.options.searchDelay;
        this.stats.throttledCount++;
        this.stats.throttledTotalTime += w;
        this.log('warn', `Channel not indexed yet. Waiting ${w}ms…`);
        await wait(w);
        return this._search();
      }

      if (!resp.ok) {
        if (resp.status === 429) {
          // Searching too fast: permanently raise the floor, then double-wait.
          let w = (await resp.json()).retry_after * 1000 || this.options.searchDelay;
          this.stats.throttledCount++;
          this.stats.throttledTotalTime += w;
          this.options.searchDelay += w; // increase delay permanently
          w = this.options.searchDelay;
          this.log('warn', `Search rate-limited. Raised searchDelay to ${w}ms. Cooling down ${w * 2}ms…`);
          await wait(w * 2);
          return this._search();
        }
        this.running = false;
        this.log('error', `Search failed with status ${resp.status}.`);
        throw resp;
      }

      this.state._resp = await resp.json();
      return this.state._resp;
    }

    _filter() {
      const data = this.state._resp;
      const total = data.total_results || 0;
      if (total > this.state.grandTotal) this.state.grandTotal = total;

      // Search returns each hit surrounded by context; keep only the actual hit.
      const found = data.messages.map((convo) => convo.find((m) => m.hit === true)).filter(Boolean);

      // Deletable message types: normal (0) and 6..21. System messages are not deletable.
      let toDelete = found.filter((m) => m.type === 0 || (m.type >= 6 && m.type <= 21));
      toDelete = toDelete.filter((m) => (m.pinned ? this.options.includePinned : true));

      this.state._toDelete = toDelete;
      this.state._skipped = found.filter((m) => !toDelete.find((x) => x.id === m.id));
    }

    async _deleteList() {
      for (const message of this.state._toDelete) {
        if (!this.running) return;
        let attempt = 0;
        while (attempt < this.options.maxAttempt) {
          const r = await this._deleteOne(message);
          if (r === 'RETRY') {
            attempt++;
            await wait(this.options.deleteDelay);
          } else break;
        }
        if (this.onProgress) this.onProgress(this.state.delCount, this.state.grandTotal, 'running');
        await wait(this.options.deleteDelay);
      }
    }

    async _deleteOne(message) {
      const url = `${API}/channels/${message.channel_id}/messages/${message.id}`;
      let resp;
      const t0 = Date.now();
      try {
        resp = await fetch(url, { method: 'DELETE', headers: { Authorization: this.options.authToken } });
      } catch (err) {
        this.log('error', 'Delete request threw: ' + err.message);
        this.state.failCount++;
        return 'FAILED';
      }
      this._ping(Date.now() - t0);

      if (!resp.ok) {
        if (resp.status === 429) {
          const w = (await resp.json()).retry_after * 1000;
          this.stats.throttledCount++;
          this.stats.throttledTotalTime += w;
          this.options.deleteDelay = w; // raise delete delay to match Discord
          this.log('warn', `Delete rate-limited ${w}ms. Set deleteDelay=${w}ms. Cooling ${w * 2}ms…`);
          await wait(w * 2);
          return 'RETRY';
        }
        const body = await resp.text();
        try {
          const j = JSON.parse(body);
          if (resp.status === 400 && j.code === 50083) {
            // Archived thread — skip so it doesn't resurface next page.
            this.state.offset++;
            this.state.failCount++;
            this.log('warn', 'Archived thread; skipping message.');
            return 'FAIL_SKIP';
          }
          this.log('error', `Delete failed ${resp.status} (code ${j.code}).`);
        } catch (_) {
          this.log('error', `Delete failed ${resp.status}.`);
        }
        this.state.failCount++;
        return 'FAILED';
      }

      this.state.delCount++;
      const when = new Date(message.timestamp).toLocaleString();
      this.log('deleted', `[${this.state.delCount}/${this.state.grandTotal}] ${when} — ${esc((message.content || '').slice(0, 100)) || (message.attachments?.length ? '[attachment]' : '[embed]')}`);
      return 'OK';
    }

    _ping(ms) {
      this.stats.avgPing = this.stats.avgPing > 0 ? this.stats.avgPing * 0.9 + ms * 0.1 : ms;
    }

    // Cheap count for the preview: one search page gives total_results.
    async countTarget(job) {
      const saveState = this.state;
      const saveOpts = { channelId: this.options.channelId, guildId: this.options.guildId };
      this.state = this._freshState();
      this.options.channelId = job.channelId || null;
      this.options.guildId = job.guildId;
      let n = 0;
      try {
        const url = this._searchUrl();
        const res = await fetch(url, { headers: { Authorization: this.options.authToken } });
        if (res.status === 202) n = -1; // not indexed yet
        else if (res.ok) n = (await res.json()).total_results || 0;
      } catch (_) {
        n = -2;
      }
      this.state = saveState;
      this.options.channelId = saveOpts.channelId;
      this.options.guildId = saveOpts.guildId;
      return n;
    }
  }

  // =====================================================================
  //  UI
  // =====================================================================
  const engine = new Engine();
  let TOKEN = null;
  let AUTHOR = null;
  let DMS = [];
  let GUILDS = [];

  const CSS = `
    #undms-btn{position:fixed;bottom:16px;right:16px;z-index:99999;background:#5865F2;color:#fff;border:none;
      border-radius:50%;width:52px;height:52px;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
    #undms-panel{position:fixed;top:5vh;right:16px;width:420px;max-height:90vh;z-index:99999;background:#2b2d31;color:#dbdee1;
      border:1px solid #1e1f22;border-radius:10px;display:none;flex-direction:column;font:13px/1.4 "gg sans",system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    #undms-panel.open{display:flex}
    .undms-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #1e1f22}
    .undms-head b{flex:1;font-size:15px;color:#f2f3f5}
    .undms-head .who{font-size:11px;color:#949ba4}
    .undms-x{background:none;border:none;color:#949ba4;font-size:18px;cursor:pointer}
    .undms-tabs{display:flex;gap:4px;padding:8px 14px 0}
    .undms-tabs button{flex:1;background:#1e1f22;color:#b5bac1;border:none;padding:7px;border-radius:6px 6px 0 0;cursor:pointer}
    .undms-tabs button.on{background:#5865F2;color:#fff}
    .undms-search{margin:8px 14px}
    .undms-search input{width:100%;box-sizing:border-box;background:#1e1f22;border:none;border-radius:6px;padding:8px;color:#dbdee1}
    .undms-list{overflow:auto;flex:1;min-height:120px;padding:0 8px}
    .undms-row{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:6px;cursor:pointer}
    .undms-row:hover{background:#35373c}
    .undms-row .meta{flex:1;min-width:0}
    .undms-row .meta .l{color:#f2f3f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .undms-row .meta .s{color:#949ba4;font-size:11px}
    .undms-row .cnt{font-size:11px;color:#949ba4;min-width:34px;text-align:right}
    .undms-row input{width:16px;height:16px;accent-color:#5865F2}
    .undms-opts{display:flex;gap:10px;padding:8px 14px;border-top:1px solid #1e1f22;flex-wrap:wrap;align-items:center}
    .undms-opts label{color:#b5bac1;font-size:11px;display:flex;flex-direction:column;gap:3px}
    .undms-opts input[type=number]{width:74px;background:#1e1f22;border:none;border-radius:5px;padding:5px;color:#dbdee1}
    .undms-actions{display:flex;gap:8px;padding:10px 14px}
    .undms-actions button{flex:1;border:none;border-radius:6px;padding:9px;cursor:pointer;font-weight:600}
    #undms-scan{background:#4e5058;color:#fff}
    #undms-run{background:#248046;color:#fff}
    #undms-stop{background:#da373c;color:#fff;display:none}
    .undms-prog{padding:0 14px 6px;color:#949ba4;font-size:11px}
    .undms-bar{height:6px;background:#1e1f22;border-radius:4px;overflow:hidden;margin:2px 0 6px}
    .undms-bar>i{display:block;height:100%;width:0;background:#248046;transition:width .2s}
    .undms-log{margin:0 8px 10px;background:#1e1f22;border-radius:6px;padding:8px;height:150px;overflow:auto;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap}
    .undms-log .error{color:#f38688}.undms-log .warn{color:#e5c07b}.undms-log .success{color:#7bd88f}
    .undms-log .deleted{color:#b5bac1}.undms-log .info{color:#8ab4f8}.undms-log .verb{color:#6b7078}
    .undms-note{padding:8px 14px;color:#e5c07b;font-size:11px;border-top:1px solid #1e1f22}
  `;

  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function build() {
    document.head.appendChild(h(`<style>${CSS}</style>`));

    const btn = h(`<button id="undms-btn" title="Undiscord Multiselect">🗑️</button>`);
    document.body.appendChild(btn);

    const panel = h(`
      <div id="undms-panel">
        <div class="undms-head">
          <b>Undiscord</b>
          <span class="who" id="undms-who">not connected</span>
          <button class="undms-x" id="undms-close">✕</button>
        </div>
        <div class="undms-tabs">
          <button data-tab="dm" class="on">Direct Messages</button>
          <button data-tab="guild">Servers</button>
        </div>
        <div class="undms-search"><input id="undms-filter" placeholder="Filter…"></div>
        <div class="undms-list" id="undms-list"></div>
        <div class="undms-opts">
          <label>Search delay (ms)<input type="number" id="undms-sd" value="30000" min="100" step="100"></label>
          <label>Delete delay (ms)<input type="number" id="undms-dd" value="1000" min="50" step="50"></label>
          <label style="flex-direction:row;align-items:center;gap:5px"><input type="checkbox" id="undms-pin"> include pinned</label>
        </div>
        <div class="undms-actions">
          <button id="undms-scan">Scan counts</button>
          <button id="undms-run">Delete selected</button>
          <button id="undms-stop">Stop</button>
        </div>
        <div class="undms-prog" id="undms-prog"></div>
        <div class="undms-bar"><i id="undms-barfill"></i></div>
        <div class="undms-log" id="undms-log"></div>
        <div class="undms-note">Deletes YOUR messages only, using your account token. Against Discord ToS — use slow delays.</div>
      </div>
    `);
    document.body.appendChild(panel);

    let tab = 'dm';
    const $ = (s) => panel.querySelector(s);
    const listEl = $('#undms-list');

    const logEl = $('#undms-log');
    engine.onLog = (level, msg) => {
      const line = document.createElement('div');
      line.className = level;
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      if (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild);
    };
    engine.onProgress = (done, total, phase) => {
      $('#undms-prog').textContent = phase === 'done'
        ? `Done. Deleted ${done}.`
        : `Deleting… ${done}${total ? ' / ~' + total : ''}`;
      $('#undms-barfill').style.width = total ? Math.min(100, (done / total) * 100) + '%' : '0';
    };

    function renderList() {
      const items = tab === 'dm' ? DMS : GUILDS;
      const q = $('#undms-filter').value.toLowerCase();
      listEl.innerHTML = '';
      items
        .filter((it) => it.label.toLowerCase().includes(q))
        .forEach((it) => {
          const row = h(`
            <label class="undms-row">
              <input type="checkbox">
              <div class="meta"><div class="l">${esc(it.label)}</div><div class="s">${esc(it.sub || '')}</div></div>
              <div class="cnt" data-cnt></div>
            </label>`);
          row.querySelector('input').checked = !!it._sel;
          row.querySelector('input').onchange = (e) => (it._sel = e.target.checked);
          if (it._count !== undefined) row.querySelector('[data-cnt]').textContent = fmtCount(it._count);
          listEl.appendChild(row);
        });
    }
    function fmtCount(n) {
      if (n === -1) return '…';
      if (n === -2) return 'err';
      return String(n);
    }

    function selected() {
      return [...DMS, ...GUILDS].filter((x) => x._sel);
    }

    // events
    $('#undms-close').onclick = () => panel.classList.remove('open');
    btn.onclick = async () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open') && !TOKEN) await connect();
    };
    panel.querySelectorAll('.undms-tabs button').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab;
        panel.querySelectorAll('.undms-tabs button').forEach((x) => x.classList.toggle('on', x === b));
        renderList();
      };
    });
    $('#undms-filter').oninput = renderList;

    $('#undms-scan').onclick = async () => {
      syncOpts();
      const sel = selected();
      if (!sel.length) return engine.log('warn', 'Select at least one target to scan.');
      engine.log('info', `Scanning ${sel.length} target(s)…`);
      for (const it of sel) {
        it._count = -1;
        renderList();
        it._count = await engine.countTarget(toJob(it));
        engine.log('verb', `${it.label}: ${fmtCount(it._count)} message(s)`);
        renderList();
        await wait(600); // gentle on the search endpoint
      }
      const totals = sel.reduce((a, it) => a + Math.max(0, it._count || 0), 0);
      engine.log('success', `Scan done. ~${totals} of your messages across ${sel.length} target(s).`);
    };

    $('#undms-run').onclick = async () => {
      syncOpts();
      const sel = selected();
      if (!sel.length) return engine.log('warn', 'Select at least one target.');
      const known = sel.filter((it) => it._count > 0).reduce((a, it) => a + it._count, 0);
      const msg = `Delete YOUR messages in ${sel.length} target(s)` + (known ? ` (~${known} known)` : '') +
        `?\n\nsearch delay ${engine.options.searchDelay}ms · delete delay ${engine.options.deleteDelay}ms\n\nThis cannot be undone.`;
      if (!confirm(msg)) return;
      $('#undms-run').style.display = 'none';
      $('#undms-stop').style.display = '';
      try {
        await engine.runBatch(sel.map(toJob));
      } finally {
        $('#undms-run').style.display = '';
        $('#undms-stop').style.display = 'none';
      }
    };

    $('#undms-stop').onclick = () => {
      engine.stop();
      engine.log('warn', 'Stopping after current message…');
    };

    function syncOpts() {
      engine.options.searchDelay = Math.max(100, parseInt($('#undms-sd').value) || 30000);
      engine.options.deleteDelay = Math.max(50, parseInt($('#undms-dd').value) || 1000);
      engine.options.includePinned = $('#undms-pin').checked;
    }

    function toJob(it) {
      return it.kind === 'guild'
        ? { label: it.label, guildId: it.guildId }
        : { label: it.label, channelId: it.channelId, guildId: '@me' };
    }

    async function connect() {
      engine.log('info', 'Grabbing token…');
      TOKEN = getToken();
      if (!TOKEN) {
        engine.log('error', 'Could not read your token automatically. Are you on discord.com and logged in?');
        return;
      }
      AUTHOR = getAuthorId(TOKEN);
      engine.options.authToken = TOKEN;
      engine.options.authorId = AUTHOR;
      $('#undms-who').textContent = AUTHOR ? `id ${AUTHOR}` : 'connected';
      engine.log('success', `Connected as ${AUTHOR || '(unknown id)'}.`);
      try {
        engine.log('info', 'Loading DMs and servers…');
        [DMS, GUILDS] = await Promise.all([discoverDMs(TOKEN), discoverGuilds(TOKEN)]);
        DMS.sort((a, b) => a.label.localeCompare(b.label));
        GUILDS.sort((a, b) => a.label.localeCompare(b.label));
        engine.log('success', `Found ${DMS.length} DMs/groups and ${GUILDS.length} servers.`);
        renderList();
      } catch (e) {
        engine.log('error', 'Discovery failed: ' + e.message);
      }
    }
  }

  if (document.body) build();
  else window.addEventListener('DOMContentLoaded', build);
})();
