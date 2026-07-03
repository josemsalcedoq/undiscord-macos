'use strict';
// Mock-fetch unit tests for the Undiscord engine + pure helpers.
// Run with: node --test
const { test } = require('node:test');
const assert = require('node:assert');
const { Engine, mergeDMs, clampDelays, MIN_SEARCH_DELAY, MIN_DELETE_DELAY, obfuscate, dateToSnowflake } =
  require('../Sources/UndiscordApp/undiscord.js');

// ---- helpers --------------------------------------------------------------
const resp = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const hit = (id) => ({ id, type: 0, hit: true, channel_id: 'c', timestamp: '2020-01-01T00:00:00Z', content: 'x', attachments: [] });

function newEngine() {
  const e = new Engine();
  e.onLog = () => {};
  e.options.authToken = 't';
  e.options.authorId = 'me';
  e.options.searchDelay = 0;
  e.options.deleteDelay = 0;
  return e;
}

// ---- pure helpers ---------------------------------------------------------
test('clampDelays enforces the minimum floors', () => {
  assert.deepEqual(clampDelays(10, 10), { searchDelay: MIN_SEARCH_DELAY, deleteDelay: MIN_DELETE_DELAY });
  assert.deepEqual(clampDelays(5000, 5000), { searchDelay: 5000, deleteDelay: 5000 });
  assert.deepEqual(clampDelays('', ''), { searchDelay: MIN_SEARCH_DELAY, deleteDelay: MIN_DELETE_DELAY });
});

test('dateToSnowflake maps dates to snowflakes and rejects bad input', () => {
  // Known: 2020-01-01T00:00:00Z → (1577836800000 - 1420070400000) << 22
  const expected = String((BigInt(Date.parse('2020-01-01T00:00:00.000Z')) - 1420070400000n) << 22n);
  assert.equal(dateToSnowflake('2020-01-01'), expected);
  // end=true shifts to the end of the day, so it is strictly larger than the start.
  assert.ok(BigInt(dateToSnowflake('2020-01-01', true)) > BigInt(dateToSnowflake('2020-01-01')));
  assert.equal(dateToSnowflake(''), null);
  assert.equal(dateToSnowflake(null), null);
  assert.equal(dateToSnowflake('not-a-date'), null);
  assert.equal(dateToSnowflake('2010-01-01'), null); // before Discord epoch
});

test('_searchUrl includes min_id/max_id only when the date range is set', () => {
  const e = newEngine();
  e.options.channelId = 'chan';
  assert.ok(!e._searchUrl().includes('min_id'));
  e.options.minId = '111';
  e.options.maxId = '222';
  const url = e._searchUrl();
  assert.match(url, /min_id=111/);
  assert.match(url, /max_id=222/);
});

test('obfuscate masks the middle of the token and keeps only the ends', () => {
  const masked = obfuscate('abcd1234EFGH5678');
  assert.ok(!masked.includes('1234EFGH'));
  assert.ok(masked.startsWith('abcd'));
  assert.ok(masked.endsWith('(16 chars)'));
  assert.equal(obfuscate(''), '(none)');
  assert.equal(obfuscate('short'), '********');
});

test('debug mode: the raw token is never written to the debug buffer', () => {
  const e = new Engine();
  e.onLog = () => {};
  e.options.authToken = 'mfa.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  e.log('info', `Authorization: ${e.options.authToken}`);
  const last = e.debugBuffer[e.debugBuffer.length - 1];
  assert.ok(!last.includes(e.options.authToken), 'raw token leaked into the buffer');
  assert.ok(last.includes('mfa.'), 'obfuscated form should keep the first 4 chars');
});

test('debug() is a no-op unless debug mode is enabled', () => {
  const e = new Engine();
  e.onLog = () => {};
  const before = e.debugBuffer.length;
  e.debug('should not record');
  assert.equal(e.debugBuffer.length, before);
  e.options.debug = true;
  e.debug('should record');
  assert.equal(e.debugBuffer.length, before + 1);
});

test('mergeDMs prefers the open DM over the friend entry and keeps groups', () => {
  const open = [
    { kind: 'dm', source: 'open', userId: 'u1', channelId: 'c1', label: 'Alice' },
    { kind: 'group', source: 'group', channelId: 'g1', label: 'Group' },
  ];
  const friends = [
    { kind: 'dm', source: 'friend', userId: 'u1', channelId: null, label: 'Alice' },
    { kind: 'dm', source: 'friend', userId: 'u2', channelId: null, label: 'Bob' },
  ];
  const merged = mergeDMs(open, friends);
  assert.equal(merged.length, 3);
  const alice = merged.find((m) => m.userId === 'u1');
  assert.equal(alice.channelId, 'c1'); // open entry won
  assert.ok(merged.find((m) => m.userId === 'u2')); // friend added
  assert.ok(merged.find((m) => m.kind === 'group'));
});

// ---- engine: search + delete ---------------------------------------------
test('search + delete removes all hits then stops on empty page', async () => {
  let searchCalls = 0, deleteCalls = 0;
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { deleteCalls++; return resp(204); }
    if (String(url).includes('/messages/search')) {
      searchCalls++;
      return searchCalls === 1
        ? resp(200, { total_results: 2, messages: [[hit('1')], [hit('2')]] })
        : resp(200, { total_results: 0, messages: [] });
    }
    return resp(200, {});
  };
  const e = newEngine();
  await e.runBatch([{ label: 'dm', channelId: 'c', guildId: '@me' }]);
  assert.equal(e.state.delCount, 2);
  assert.equal(deleteCalls, 2);
});

test('delete 429 backs off and retries the same message', async () => {
  let searchCalls = 0, firstDelete = true;
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') {
      if (firstDelete) { firstDelete = false; return resp(429, { retry_after: 0.001 }); }
      return resp(204);
    }
    searchCalls++;
    return searchCalls === 1
      ? resp(200, { total_results: 1, messages: [[hit('1')]] })
      : resp(200, { total_results: 0, messages: [] });
  };
  const e = newEngine();
  await e.runBatch([{ label: 'dm', channelId: 'c', guildId: '@me' }]);
  assert.equal(e.state.delCount, 1);
  assert.ok(e.stats.throttledCount >= 1);
});

test('delete 404 is treated as already-deleted (counts as success)', async () => {
  let searchCalls = 0;
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') return resp(404, { code: 10008 });
    searchCalls++;
    return searchCalls === 1
      ? resp(200, { total_results: 1, messages: [[hit('1')]] })
      : resp(200, { total_results: 0, messages: [] });
  };
  const e = newEngine();
  await e.runBatch([{ label: 'dm', channelId: 'c', guildId: '@me' }]);
  assert.equal(e.state.delCount, 1);
});

test('final verification sweeps up an index-lag leftover without reconfirmation', async () => {
  // Discord's search index lags behind deletes: the first sweep sees msg 1, deletes it,
  // then gets an empty page (msg 2 not indexed yet) and stops. The verification pass must
  // re-scan, find msg 2, and delete it — with no extra confirmation.
  const pages = [
    { total_results: 1, messages: [[hit('1')]] }, // sweep: msg 1
    { total_results: 0, messages: [] },            // sweep: empty (lag) → stops
    { total_results: 1, messages: [[hit('2')]] },  // verify: leftover msg 2 appears
    { total_results: 0, messages: [] },            // verify's mop-up sweep: empty
  ];
  let deleteCalls = 0;
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { deleteCalls++; return resp(204); }
    return resp(200, pages.shift() || { total_results: 0, messages: [] });
  };
  const e = newEngine();
  await e.runBatch([{ label: 'dm', channelId: 'c', guildId: '@me' }]);
  assert.equal(e.state.delCount, 2); // msg 1 in the sweep, msg 2 caught by verification
  assert.equal(deleteCalls, 2);
});

test('runBatch always reaches a terminal state and clears running on a search error', async () => {
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/messages/search')) return resp(500); // hard failure
    return resp(200, {});
  };
  const e = newEngine();
  let lastPhase = null;
  e.onProgress = (p) => { lastPhase = p.phase; };
  await e.runBatch([{ label: 'dm', channelId: 'c', guildId: '@me' }]); // must not reject
  assert.equal(e.running, false);
  assert.equal(lastPhase, 'done'); // UI driven to a terminal state, not frozen mid-delete
});

test('openDM returns the new channel id, or null when Discord refuses', async () => {
  // Backs the Imported tab's "Open DM": success → reopened channel id, failure → null.
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/users/@me/channels') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return body.recipients[0] === 'blocked' ? resp(403, { message: 'nope' }) : resp(200, { id: 'chan-987' });
    }
    return resp(200, {});
  };
  const e = newEngine();
  assert.equal(await e.openDM('u1'), 'chan-987');
  assert.equal(await e.openDM('blocked'), null);
});

// ---- engine: imported id-list deletion ------------------------------------
test('imported target deletes by id list without searching', async () => {
  let searchCalls = 0, deleteCalls = 0;
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { deleteCalls++; return resp(204); }
    searchCalls++;
    return resp(200, { total_results: 0, messages: [] });
  };
  const e = newEngine();
  await e.runBatch([{ label: 'imported', channelId: 'c', messageIds: ['1', '2', '3'] }]);
  assert.equal(e.state.delCount, 3);
  assert.equal(deleteCalls, 3);
  assert.equal(searchCalls, 0); // no search for imported targets
});

// ---- engine: system messages are skipped ----------------------------------
test('system messages (type 1-5) are not deleted', async () => {
  let searchCalls = 0, deleteCalls = 0;
  const sys = { id: 's', type: 3, hit: true, channel_id: 'c', timestamp: '2020', content: '', attachments: [] };
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { deleteCalls++; return resp(204); }
    searchCalls++;
    // one page with only a system message → engine advances past it, then empty
    return searchCalls === 1
      ? resp(200, { total_results: 1, messages: [[sys]] })
      : resp(200, { total_results: 0, messages: [] });
  };
  const e = newEngine();
  await e.runBatch([{ label: 'dm', channelId: 'c', guildId: '@me' }]);
  assert.equal(deleteCalls, 0);
  assert.equal(e.state.delCount, 0);
});
