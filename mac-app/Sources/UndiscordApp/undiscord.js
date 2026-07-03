/**
 * Undiscord panel — injected into the app's Discord web view.
 * Discovers your DMs, friends, servers and imported conversations, then bulk-deletes
 * your own messages with a conservative, self-throttling rate limiter.
 *
 * Uses your own account token. Automating a user account violates Discord's ToS and
 * carries a ban risk independent of speed — for deleting your own messages only.
 * Rate-limit engine adapted from victornpb/undiscord.
 */

(function () {
  'use strict';

  const API = 'https://discord.com/api/v9';
  const CDN = 'https://cdn.discordapp.com';
  const PREFIX = '[undiscord-ms]';

  // Hard floors on the delays. Below these, Discord's search/delete routes rate-limit
  // aggressively and the traffic pattern looks automated — so they cannot be lowered.
  const MIN_SEARCH_DELAY = 2000;
  const MIN_DELETE_DELAY = 700;
  const clampDelays = (search, del) => ({
    searchDelay: Math.max(MIN_SEARCH_DELAY, parseInt(search) || 0),
    deleteDelay: Math.max(MIN_DELETE_DELAY, parseInt(del) || 0),
  });

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

  const AV_COLORS = ['#5865f2', '#3ba55d', '#faa81a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22'];
  const colorFor = (str) => {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    return AV_COLORS[Math.abs(h) % AV_COLORS.length];
  };
  const userAvatar = (id, hash, size = 64) =>
    hash ? `${CDN}/avatars/${id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=${size}` : null;
  const guildIcon = (id, hash, size = 64) => (hash ? `${CDN}/icons/${id}/${hash}.png?size=${size}` : null);

  function avatarHtml(item, round = true) {
    const cls = round ? 'undms-av' : 'undms-av sq';
    if (item.avatarUrl) return `<img class="${cls}" src="${item.avatarUrl}" loading="lazy" alt="">`;
    const letter = esc((item.label || '?').trim().charAt(0).toUpperCase() || '?');
    return `<div class="${cls} ph" style="background:${colorFor(item.label || item.channelId || 'x')}">${letter}</div>`;
  }

  // ------------------------------------------------- token / identity grabs --
  function getToken() {
    try {
      window.dispatchEvent(new Event('beforeunload'));
      const iframe = document.body.appendChild(document.createElement('iframe'));
      const raw = iframe.contentWindow.localStorage.token;
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

  async function apiGet(path, token) {
    const res = await fetch(API + path, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  }

  async function getMe(token) {
    try {
      const me = await apiGet('/users/@me', token);
      return me;
    } catch (_) {
      // fall back to id from token
      try {
        const id = atob(token.split('.')[0]);
        if (/^\d+$/.test(id)) return { id };
      } catch (_) {}
      return null;
    }
  }

  // Open DMs + group DMs.
  async function discoverDMs(token) {
    const channels = await apiGet('/users/@me/channels', token);
    const out = [];
    for (const c of channels) {
      if (c.type === 1) {
        const r = c.recipients?.[0];
        out.push({
          kind: 'dm', source: 'open', channelId: c.id,
          userId: r?.id,
          label: r ? (r.global_name || r.username || r.id) : 'Unknown',
          sub: r?.username ? `@${r.username}` : '',
          avatarUrl: userAvatar(r?.id, r?.avatar),
        });
      } else if (c.type === 3) {
        const names = (c.recipients || []).map((r) => r.global_name || r.username).join(', ');
        out.push({
          kind: 'group', source: 'group', channelId: c.id,
          label: c.name || names || 'Group DM',
          sub: `group · ${(c.recipients || []).length + 1} people`,
          avatarUrl: c.icon ? `${CDN}/channel-icons/${c.id}/${c.icon}.png?size=64` : null,
        });
      }
    }
    return out;
  }

  // Friends (relationships type 1) — lets us reach DMs that aren't currently open.
  async function discoverFriends(token) {
    let rels = [];
    try {
      rels = await apiGet('/users/@me/relationships', token);
    } catch (_) {
      return [];
    }
    return rels
      .filter((r) => r.type === 1 && r.user)
      .map((r) => ({
        kind: 'dm', source: 'friend', channelId: null, userId: r.user.id,
        label: r.nickname || r.user.global_name || r.user.username || r.user.id,
        sub: `@${r.user.username} · friend`,
        avatarUrl: userAvatar(r.user.id, r.user.avatar),
      }));
  }

  async function discoverGuilds(token) {
    const guilds = await apiGet('/users/@me/guilds', token);
    return guilds.map((g) => ({
      kind: 'guild', source: 'server', guildId: g.id,
      label: g.name, sub: 'server',
      avatarUrl: guildIcon(g.id, g.icon),
    }));
  }

  // Merge open DMs + friends: prefer the open-DM entry (has channelId); add friends
  // that aren't already open. Group DMs pass through untouched.
  function mergeDMs(open, friends) {
    const byUser = new Map();
    const groups = [];
    for (const it of open) {
      if (it.kind === 'group') groups.push(it);
      else if (it.userId) byUser.set(it.userId, it);
    }
    for (const f of friends) {
      if (!byUser.has(f.userId)) byUser.set(f.userId, f);
    }
    return [...groups, ...byUser.values()];
  }

  // =====================================================================
  //  Deletion engine — rate-limit behaviour ported from victornpb/undiscord
  // =====================================================================
  class Engine {
    constructor() {
      this.options = {
        authToken: null, authorId: null,
        searchDelay: 30000, deleteDelay: 1000,
        includePinned: false, maxAttempt: 2,
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

    stop() { this.running = false; }

    // Open (or reuse) the DM channel for a user id.
    async openDM(userId) {
      try {
        const res = await fetch(`${API}/users/@me/channels`, {
          method: 'POST',
          headers: { Authorization: this.options.authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipients: [userId] }),
        });
        if (!res.ok) return null;
        return (await res.json()).id;
      } catch (_) {
        return null;
      }
    }

    async _resolveChannel(job) {
      if (job.channelId) return job.channelId;
      if (job.guildId === '@me' && job.userId) {
        const cid = await this.openDM(job.userId);
        if (cid) job.channelId = cid;
        return cid;
      }
      return null;
    }

    async runBatch(queue) {
      if (this.running) return this.log('error', 'Already running.');
      this.running = true;
      this.stats.startTime = Date.now();
      let grand = { del: 0, fail: 0 };
      this.log('info', `Starting batch of ${queue.length} target(s).`);

      for (let i = 0; i < queue.length && this.running; i++) {
        const job = queue[i];
        this.state = this._freshState();
        this.log('info', `\n[${i + 1}/${queue.length}] ${job.label}`);

        // Imported (data-package) target: delete directly by message id, no search.
        if (job.messageIds) {
          if (this.onProgress) this.onProgress({ done: 0, total: job.messageIds.length, phase: 'target', target: job.label });
          await this._runIdList(job);
          grand.del += this.state.delCount;
          grand.fail += this.state.failCount;
          continue;
        }

        const cid = await this._resolveChannel(job);
        if (job.guildId === '@me' && !cid) {
          this.log('error', `Could not open a DM channel for ${job.label}; skipping.`);
          continue;
        }
        this.options.channelId = job.channelId || null;
        this.options.guildId = job.guildId;

        if (this.onProgress) this.onProgress({ done: 0, total: 0, phase: 'target', target: job.label });
        await this._runOne();
        grand.del += this.state.delCount;
        grand.fail += this.state.failCount;
      }

      this.running = false;
      this.log('success', `Batch finished. Deleted ${grand.del}, failed ${grand.fail}. Total time ${msToHMS(Date.now() - this.stats.startTime)}.`);
      if (this.onProgress) this.onProgress({ done: grand.del, total: grand.del, phase: 'done', target: '' });
    }

    async _runOne() {
      do {
        await this._search();
        if (!this.running) break;
        this._filter();

        if (this.state._toDelete.length > 0) {
          await this._deleteList();
        } else if (this.state._skipped.length > 0) {
          this.state.offset += this.state._skipped.length;
        } else {
          break; // empty page => done
        }
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
          let w = (await resp.json()).retry_after * 1000 || this.options.searchDelay;
          this.stats.throttledCount++;
          this.stats.throttledTotalTime += w;
          this.options.searchDelay += w;
          w = this.options.searchDelay;
          this.log('warn', `Search rate-limited. Raised searchDelay to ${w}ms. Cooling ${w * 2}ms…`);
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

      const found = data.messages.map((convo) => convo.find((m) => m.hit === true)).filter(Boolean);
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
          if (r === 'RETRY') { attempt++; await wait(this.options.deleteDelay); }
          else break;
        }
        if (this.onProgress) this.onProgress({ done: this.state.delCount, total: this.state.grandTotal, phase: 'running', target: '' });
        await wait(this.options.deleteDelay);
      }
    }

    // Delete an explicit list of message ids (from a data-package import) directly,
    // with the same rate-limit backoff. No search needed; the package holds channel+id.
    async _runIdList(job) {
      const ids = job.messageIds || [];
      this.state.grandTotal = ids.length;
      for (const id of ids) {
        if (!this.running) return;
        let attempt = 0;
        while (attempt < this.options.maxAttempt) {
          const r = await this._deleteOne({ channel_id: job.channelId, id, timestamp: null, content: '' });
          if (r === 'RETRY') { attempt++; await wait(this.options.deleteDelay); }
          else break;
        }
        if (this.onProgress) this.onProgress({ done: this.state.delCount, total: this.state.grandTotal, phase: 'running', target: '' });
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
        if (resp.status === 404) { this.state.delCount++; return 'OK'; } // already deleted
        if (resp.status === 429) {
          const w = (await resp.json()).retry_after * 1000;
          this.stats.throttledCount++;
          this.stats.throttledTotalTime += w;
          this.options.deleteDelay = w;
          this.log('warn', `Delete rate-limited ${w}ms. Set deleteDelay=${w}ms. Cooling ${w * 2}ms…`);
          await wait(w * 2);
          return 'RETRY';
        }
        const body = await resp.text();
        try {
          const j = JSON.parse(body);
          if (resp.status === 400 && j.code === 50083) {
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
      const when = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
      const body = esc((message.content || '').slice(0, 100)) || (message.attachments?.length ? '[attachment]' : '#' + message.id);
      this.log('deleted', `[${this.state.delCount}/${this.state.grandTotal}] ${when} ${when ? '— ' : ''}${body}`);
      return 'OK';
    }

    _ping(ms) {
      this.stats.avgPing = this.stats.avgPing > 0 ? this.stats.avgPing * 0.9 + ms * 0.1 : ms;
    }

    async countTarget(job) {
      if (job.messageIds) return job.messageIds.length; // imported: count is known
      const cid = await this._resolveChannel(job);
      if (job.guildId === '@me' && !cid) return -3; // couldn't open DM
      const save = { ch: this.options.channelId, g: this.options.guildId, st: this.state };
      this.state = this._freshState();
      this.options.channelId = job.channelId || null;
      this.options.guildId = job.guildId;
      let n = -1; // -1 = still indexing
      try {
        // A just-opened DM may not be indexed yet (202); retry a few times.
        for (let attempt = 0; attempt < 5; attempt++) {
          const res = await fetch(this._searchUrl(), { headers: { Authorization: this.options.authToken } });
          if (res.status === 202) {
            const body = await res.json().catch(() => ({}));
            await wait(body.retry_after ? body.retry_after * 1000 : 1200);
            continue;
          }
          n = res.ok ? ((await res.json()).total_results || 0) : -2;
          break;
        }
      } catch (_) { n = -2; }
      this.state = save.st; this.options.channelId = save.ch; this.options.guildId = save.g;
      return n;
    }
  }

  // =====================================================================
  //  UI
  // =====================================================================
  const engine = new Engine();
  let TOKEN = null, ME = null;
  let DMS = [], GUILDS = [], IMPORTED = [];

  const ICON = {
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  };

  const CSS = `
    :root{ --u-bg:#313338; --u-bg2:#2b2d31; --u-bg3:#1e1f22; --u-hover:#383a40; --u-line:#232428;
      --u-tx:#f2f3f5; --u-mut:#b5bac1; --u-dim:#949ba4; --u-acc:#5865f2; --u-acch:#4752c4;
      --u-red:#da373c; --u-redh:#a12828; --u-grn:#2dc770; --u-r:8px; }
    #undms-btn{position:fixed;bottom:22px;right:22px;z-index:2147483000;width:54px;height:54px;border:none;
      border-radius:16px;cursor:pointer;background:linear-gradient(145deg,#5865f2,#4752c4);color:#fff;
      display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06) inset;
      transition:transform .15s ease, box-shadow .15s ease, border-radius .2s ease}
    #undms-btn svg{width:24px;height:24px}
    #undms-btn:hover{transform:translateY(-2px) scale(1.05);border-radius:18px;box-shadow:0 10px 26px rgba(88,101,242,.5)}
    #undms-btn:active{transform:translateY(0) scale(.97)}
    #undms-btn .badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;
      background:var(--u-red);color:#fff;font:700 11px/20px system-ui;box-shadow:0 0 0 2px var(--u-bg2);display:none}

    #undms-panel{position:fixed;top:4vh;right:22px;width:440px;max-height:90vh;z-index:2147483000;background:var(--u-bg);
      color:var(--u-tx);border:1px solid var(--u-line);border-radius:14px;display:none;flex-direction:column;overflow:hidden;
      font:14px/1.4 "gg sans","Noto Sans",system-ui,sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.6);
      animation:undms-in .18s cubic-bezier(.2,.8,.2,1)}
    @keyframes undms-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
    #undms-panel.open{display:flex}
    #undms-panel *{box-sizing:border-box}
    #undms-panel button{font-family:inherit}

    .undms-head{display:flex;align-items:center;gap:10px;padding:13px 14px;background:var(--u-bg2);border-bottom:1px solid var(--u-line)}
    .undms-head .undms-av{width:30px;height:30px}
    .undms-head .h-tt{flex:1;min-width:0}
    .undms-head .h-tt b{display:block;font-size:15px;font-weight:700}
    .undms-head .h-tt span{display:block;font-size:12px;color:var(--u-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .undms-x{width:30px;height:30px;flex:none;background:none;border:none;color:var(--u-dim);border-radius:8px;cursor:pointer;
      display:flex;align-items:center;justify-content:center}
    .undms-x svg{width:18px;height:18px}
    .undms-x:hover{background:var(--u-hover);color:var(--u-tx)}

    .undms-tabs{display:flex;gap:6px;padding:12px 14px 4px}
    .undms-tabs button{flex:1;background:var(--u-bg3);color:var(--u-mut);border:none;padding:9px;border-radius:9px;cursor:pointer;
      font-weight:600;font-size:13px;transition:background .12s,color .12s}
    .undms-tabs button:hover{color:var(--u-tx)}
    .undms-tabs button.on{background:var(--u-acc);color:#fff}

    .undms-search{position:relative;margin:8px 14px}
    .undms-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--u-dim)}
    .undms-search input{width:100%;background:var(--u-bg3);border:1px solid transparent;border-radius:9px;padding:9px 10px 9px 32px;
      color:var(--u-tx);outline:none}
    .undms-search input:focus{border-color:var(--u-acc)}

    .undms-list{overflow-y:auto;flex:1 1 auto;min-height:84px;max-height:30vh;padding:2px 8px 6px}
    .undms-list::-webkit-scrollbar{width:8px}.undms-list::-webkit-scrollbar-thumb{background:#1a1b1e;border-radius:8px}
    .undms-row{display:flex;align-items:center;gap:11px;padding:8px 9px;border-radius:9px;cursor:pointer;transition:background .1s}
    .undms-row:hover{background:var(--u-hover)}
    .undms-row.sel{background:rgba(88,101,242,.14)}
    .undms-av{width:36px;height:36px;flex:none;border-radius:50%;object-fit:cover;display:flex;align-items:center;justify-content:center;
      color:#fff;font-weight:700;font-size:15px}
    .undms-av.sq{border-radius:12px}
    .undms-row .meta{flex:1;min-width:0}
    .undms-row .meta .l{color:var(--u-tx);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .undms-row .meta .s{color:var(--u-dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .undms-row .cnt{font-size:12px;color:var(--u-dim);min-width:30px;text-align:right}
    .undms-row .cnt.has{color:var(--u-grn);font-weight:600}
    .undms-chk{width:20px;height:20px;flex:none;border-radius:6px;border:2px solid #4e5058;display:flex;align-items:center;justify-content:center}
    .undms-row.sel .undms-chk{background:var(--u-acc);border-color:var(--u-acc)}
    .undms-chk svg{width:12px;height:12px;color:#fff;opacity:0;stroke-width:3.5}
    .undms-row.sel .undms-chk svg{opacity:1}
    .undms-empty{padding:26px 16px;text-align:center;color:var(--u-dim);font-size:13px;line-height:1.5}
    .undms-empty small{display:block;margin:8px 0 4px;color:#72767d}
    .undms-imp-btn{margin-top:12px;background:var(--u-acc);color:#fff;border:none;border-radius:9px;padding:9px 16px;font-weight:600;cursor:pointer}
    .undms-imp-btn:hover{background:var(--u-acch)}
    .undms-optnote{padding:0 14px 12px;color:#e5c07b;font-size:11px;line-height:1.4}

    .undms-adv{border-top:1px solid var(--u-line)}
    .undms-adv summary{list-style:none;cursor:pointer;padding:9px 14px;color:var(--u-mut);font-size:12px;font-weight:600;user-select:none}
    .undms-adv summary::-webkit-details-marker{display:none}
    .undms-adv summary:hover{color:var(--u-tx)}
    .undms-opts{display:flex;gap:12px;padding:2px 14px 12px;flex-wrap:wrap;align-items:flex-end}
    .undms-opts label{color:var(--u-dim);font-size:11px;font-weight:600;display:flex;flex-direction:column;gap:4px;text-transform:uppercase;letter-spacing:.02em}
    .undms-opts input[type=number]{width:88px;background:var(--u-bg3);border:1px solid transparent;border-radius:7px;padding:7px;color:var(--u-tx);outline:none}
    .undms-opts input[type=number]:focus{border-color:var(--u-acc)}
    .undms-opts .chk{flex-direction:row;align-items:center;gap:7px;text-transform:none;letter-spacing:0}
    .undms-opts .chk input{width:16px;height:16px;accent-color:var(--u-acc)}

    .undms-sum{display:flex;justify-content:space-between;padding:9px 14px;font-size:12px;color:var(--u-mut);border-top:1px solid var(--u-line)}
    .undms-sum b{color:var(--u-tx)}
    .undms-actions{display:flex;gap:9px;padding:4px 14px 12px}
    .undms-actions button{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;border:none;border-radius:9px;padding:11px;
      cursor:pointer;font-weight:600;font-size:14px;transition:background .12s,opacity .12s}
    .undms-actions button svg{width:16px;height:16px}
    .undms-actions button:disabled{opacity:.45;cursor:not-allowed}
    #undms-scan{background:#4e5058;color:#fff}#undms-scan:hover:not(:disabled){background:#5c5e66}
    #undms-run{background:var(--u-red);color:#fff}#undms-run:hover:not(:disabled){background:var(--u-redh)}
    #undms-stop{background:var(--u-red);color:#fff;display:none}

    .undms-prog{padding:0 14px}
    .undms-prog .pl{display:flex;justify-content:space-between;font-size:11px;color:var(--u-dim);margin-bottom:5px}
    .undms-bar{height:7px;background:var(--u-bg3);border-radius:5px;overflow:hidden}
    .undms-bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#5865f2,#2dc770);transition:width .25s}
    .undms-log{margin:8px 8px 10px;background:var(--u-bg3);border-radius:9px;padding:9px;height:210px;overflow:auto;
      font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
    .undms-log::-webkit-scrollbar{width:8px}.undms-log::-webkit-scrollbar-thumb{background:#111;border-radius:8px}
    .undms-log .error{color:#f38688}.undms-log .warn{color:#e5c07b}.undms-log .success{color:#7bd88f}
    .undms-log .deleted{color:var(--u-mut)}.undms-log .info{color:#89b4fa}.undms-log .verb{color:#6b7078}
    .undms-note{padding:9px 14px;color:#e5c07b;font-size:11px;background:var(--u-bg2);border-top:1px solid var(--u-line)}
  `;

  const h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  function build() {
    document.head.appendChild(h(`<style>${CSS}</style>`));

    const btn = h(`<button id="undms-btn" title="Undiscord">${ICON.trash}<span class="badge">0</span></button>`);
    document.body.appendChild(btn);

    const panel = h(`
      <div id="undms-panel">
        <div class="undms-head">
          <div class="undms-av ph" id="undms-me-av" style="background:#5865f2"></div>
          <div class="h-tt"><b>Undiscord</b><span id="undms-who">not connected</span></div>
          <button class="undms-x" id="undms-close">${ICON.close}</button>
        </div>
        <div class="undms-tabs">
          <button data-tab="dm" class="on">Direct Messages</button>
          <button data-tab="guild">Servers</button>
          <button data-tab="import">Imported</button>
        </div>
        <div class="undms-search">${ICON.search}<input id="undms-filter" placeholder="Filter…"></div>
        <div class="undms-list" id="undms-list"></div>
        <details class="undms-adv">
          <summary>⚙ Advanced settings</summary>
          <div class="undms-opts">
            <label>Search delay (ms)<input type="number" id="undms-sd" value="30000" min="2000" step="100"></label>
            <label>Delete delay (ms)<input type="number" id="undms-dd" value="1000" min="700" step="50"></label>
            <label class="chk"><input type="checkbox" id="undms-pin"> include pinned</label>
          </div>
          <div class="undms-optnote">Enforced minimums: search ≥ 2000ms, delete ≥ 700ms — going lower gets you rate-limited and risks a ban.</div>
        </details>
        <div class="undms-sum"><span id="undms-selinfo">0 selected</span><span id="undms-cntinfo"></span></div>
        <div class="undms-actions">
          <button id="undms-scan">${ICON.search} Scan counts</button>
          <button id="undms-run">${ICON.trash} Delete selected</button>
          <button id="undms-stop">${ICON.stop} Stop</button>
        </div>
        <div class="undms-prog"><div class="pl"><span id="undms-plabel"></span><span id="undms-ppct"></span></div><div class="undms-bar"><i id="undms-barfill"></i></div></div>
        <div class="undms-log" id="undms-log"></div>
        <div class="undms-note">Deletes YOUR messages only, using your account token. Against Discord ToS — keep delays slow.</div>
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
      if (logEl.childElementCount > 600) logEl.removeChild(logEl.firstChild);
    };
    engine.onProgress = ({ done, total, phase, target }) => {
      if (phase === 'target') { $('#undms-plabel').textContent = 'Deleting: ' + target; }
      else if (phase === 'done') { $('#undms-plabel').textContent = `Done — deleted ${done}.`; $('#undms-ppct').textContent = ''; $('#undms-barfill').style.width = '100%'; return; }
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      $('#undms-ppct').textContent = total ? `${done}/~${total}` : `${done}`;
      $('#undms-barfill').style.width = pct + '%';
    };

    const fmtCount = (n) => (n === -1 ? '…' : n === -2 ? 'err' : n === -3 ? '—' : String(n));
    const selected = () => [...DMS, ...GUILDS, ...IMPORTED].filter((x) => x._sel);

    const requestImport = () => {
      const bridge = window.webkit?.messageHandlers?.undms;
      if (!bridge) return engine.log('error', 'Data-package import is only available in the native app.');
      engine.log('info', 'Opening file picker… choose your Discord data package (.zip) or its folder.');
      bridge.postMessage({ action: 'import' });
    };
    window.__undmsStatus = (m) => engine.log('info', m);
    window.__undmsImport = (arr) => {
      IMPORTED = (arr || []).map((c) => ({
        kind: 'import', source: 'package', channelId: c.channelId, type: c.type,
        label: c.label || `DM ${c.channelId}`,
        sub: `${(c.count || 0).toLocaleString()} messages · package`,
        count: c.count || (c.messageIds || []).length,
        messageIds: c.messageIds || [], avatarUrl: null,
      })).sort((a, b) => b.count - a.count);
      tab = 'import';
      panel.querySelectorAll('.undms-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'import'));
      renderList(); updateSummary();
      const total = IMPORTED.reduce((a, c) => a + c.count, 0);
      engine.log('success', `Imported ${IMPORTED.length} conversations (~${total.toLocaleString()} of your messages) from the data package.`);
    };

    function updateSummary() {
      const sel = selected();
      $('#undms-selinfo').innerHTML = `<b>${sel.length}</b> selected`;
      const known = sel.filter((x) => x._count > 0).reduce((a, x) => a + x._count, 0);
      $('#undms-cntinfo').innerHTML = known ? `~<b>${known.toLocaleString()}</b> messages` : '';
      const badge = btn.querySelector('.badge');
      badge.textContent = sel.length;
      badge.style.display = sel.length ? 'block' : 'none';
    }

    function renderList() {
      const items = tab === 'dm' ? DMS : tab === 'guild' ? GUILDS : IMPORTED;
      const q = $('#undms-filter').value.toLowerCase();
      const filtered = items.filter((it) => it.label.toLowerCase().includes(q));
      listEl.innerHTML = '';
      if (tab === 'import' && !IMPORTED.length) {
        const box = h(`<div class="undms-empty">Import your <b>Discord Data Package</b> to reach every DM/group you have ever had — even closed ones.<small>Request it in Discord → Settings → Data &amp; Privacy → Request all of my Data (arrives in a few days). Then load the .zip here.</small><button class="undms-imp-btn">Import Data Package…</button></div>`);
        box.querySelector('button').onclick = requestImport;
        listEl.appendChild(box);
        return;
      }
      if (!filtered.length) {
        listEl.appendChild(h(`<div class="undms-empty">${TOKEN ? 'Nothing here.' : 'Connecting…'}${tab === 'dm' && TOKEN ? '<small>Closed DMs with non-friends only appear via a Data Package import (Imported tab).</small>' : ''}</div>`));
        return;
      }
      for (const it of filtered) {
        const row = h(`
          <label class="undms-row${it._sel ? ' sel' : ''}">
            ${avatarHtml(it, it.kind !== 'guild')}
            <div class="meta"><div class="l">${esc(it.label)}</div><div class="s">${esc(it.sub || '')}</div></div>
            <div class="cnt${it._count > 0 ? ' has' : ''}" data-cnt>${it._count !== undefined ? fmtCount(it._count) : ''}</div>
            <div class="undms-chk">${ICON_CHECK}</div>
          </label>`);
        const img = row.querySelector('img.undms-av');
        if (img) img.onerror = () => img.replaceWith(h(avatarHtml({ ...it, avatarUrl: null }, it.kind !== 'guild')));
        row.onclick = (e) => {
          e.preventDefault();
          it._sel = !it._sel;
          row.classList.toggle('sel', it._sel);
          updateSummary();
        };
        listEl.appendChild(row);
      }
    }

    const toJob = (it) =>
      it.kind === 'guild'
        ? { label: it.label, guildId: it.guildId }
        : it.kind === 'import'
        ? { label: it.label, channelId: it.channelId, messageIds: it.messageIds }
        : { label: it.label, channelId: it.channelId || null, userId: it.userId, guildId: '@me' };

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

    function syncOpts() {
      const rawS = parseInt($('#undms-sd').value) || 0;
      const rawD = parseInt($('#undms-dd').value) || 0;
      const c = clampDelays(rawS || 30000, rawD || 1000);
      if (rawS && rawS < MIN_SEARCH_DELAY) {
        engine.log('warn', `Search delay raised to the ${MIN_SEARCH_DELAY}ms minimum — Discord's search endpoint rate-limits hard below this.`);
        $('#undms-sd').value = c.searchDelay;
      }
      if (rawD && rawD < MIN_DELETE_DELAY) {
        engine.log('warn', `Delete delay raised to the ${MIN_DELETE_DELAY}ms minimum — faster deletes get throttled and look automated (ban risk).`);
        $('#undms-dd').value = c.deleteDelay;
      }
      engine.options.searchDelay = c.searchDelay;
      engine.options.deleteDelay = c.deleteDelay;
      engine.options.includePinned = $('#undms-pin').checked;
    }
    function setBusy(busy) {
      $('#undms-scan').disabled = busy;
      $('#undms-run').style.display = busy ? 'none' : '';
      $('#undms-stop').style.display = busy ? '' : 'none';
    }

    $('#undms-scan').onclick = async () => {
      syncOpts();
      const sel = selected();
      if (!sel.length) return engine.log('warn', 'Select at least one target to scan.');
      $('#undms-scan').disabled = true;
      engine.log('info', `Scanning ${sel.length} target(s)…`);
      for (const it of sel) {
        it._count = -1; renderList(); updateSummary();
        const job = toJob(it);
        it._count = await engine.countTarget(job);
        if (job.channelId && !it.channelId) it.channelId = job.channelId; // cache opened DM channel
        renderList(); updateSummary();
        await wait(700);
      }
      const totals = sel.reduce((a, it) => a + Math.max(0, it._count || 0), 0);
      engine.log('success', `Scan done. ~${totals} of your messages across ${sel.length} target(s).`);
      $('#undms-scan').disabled = false;
    };

    $('#undms-run').onclick = async () => {
      syncOpts();
      const sel = selected();
      if (!sel.length) return engine.log('warn', 'Select at least one target.');
      const known = sel.filter((it) => it._count > 0).reduce((a, it) => a + it._count, 0);
      const msg = `Delete YOUR messages in ${sel.length} target(s)` + (known ? ` (~${known} known)` : '') +
        `?\n\nsearch delay ${engine.options.searchDelay}ms · delete delay ${engine.options.deleteDelay}ms\n\nThis cannot be undone.`;
      if (!confirm(msg)) return;
      setBusy(true);
      try { await engine.runBatch(sel.map(toJob)); }
      finally { setBusy(false); }
    };

    $('#undms-stop').onclick = () => { engine.stop(); engine.log('warn', 'Stopping after current message…'); };

    async function connect() {
      engine.log('info', 'Grabbing token…');
      TOKEN = getToken();
      if (!TOKEN) return engine.log('error', 'Could not read your token. Are you logged in to Discord?');
      engine.options.authToken = TOKEN;
      ME = await getMe(TOKEN);
      engine.options.authorId = ME?.id || null;
      if (ME) {
        $('#undms-who').textContent = ME.global_name || ME.username || `id ${ME.id}`;
        const av = userAvatar(ME.id, ME.avatar, 64);
        const avEl = $('#undms-me-av');
        if (av) { const img = h(`<img class="undms-av" src="${av}" alt="">`); avEl.replaceWith(img); img.id = 'undms-me-av'; }
        else avEl.textContent = (ME.username || '?').charAt(0).toUpperCase();
      }
      engine.log('success', `Connected as ${ME?.username || ME?.id || '(unknown)'}.`);
      try {
        engine.log('info', 'Loading DMs, friends and servers…');
        const [open, friends, guilds] = await Promise.all([
          discoverDMs(TOKEN), discoverFriends(TOKEN), discoverGuilds(TOKEN),
        ]);
        DMS = mergeDMs(open, friends).sort((a, b) => a.label.localeCompare(b.label));
        GUILDS = guilds.sort((a, b) => a.label.localeCompare(b.label));
        const openCount = DMS.filter((d) => d.source === 'open').length;
        const friendCount = DMS.filter((d) => d.source === 'friend').length;
        engine.log('success', `Found ${DMS.length} people (${openCount} open DMs + ${friendCount} friends) and ${GUILDS.length} servers.`);
        renderList(); updateSummary();
      } catch (e) {
        engine.log('error', 'Discovery failed: ' + e.message);
      }
    }
  }

  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // Only build the UI in a real browser/web view; skipped under Node (tests).
  if (typeof document !== 'undefined') {
    if (document.body) build();
    else window.addEventListener('DOMContentLoaded', build);
  }

  // Export the pure logic for Node-based unit tests (no-op in the web view).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Engine, mergeDMs, clampDelays, MIN_SEARCH_DELAY, MIN_DELETE_DELAY, userAvatar, guildIcon };
  }
})();
