// Build Wall client for the Supabase REST API (PostgREST). Loaded by every page after config.js.
(function () {
  const cfg = window.BUILD_WALL_CONFIG || {};
  const base = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  const key = String(cfg.supabaseAnonKey || '');
  const configured = /^https?:\/\//.test(base) && key.length > 20 && !/YOUR-/.test(base + key);
  function csv(rows) {
    const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const lines = ['name,answer,submitted_at,hidden'];
    for (const r of rows || []) lines.push([cell(r.name), cell(r.text), cell(r.created_at), r.hidden ? 'yes' : 'no'].join(','));
    return lines.join('\r\n') + '\r\n';
  }
  // The wall starts fresh every day: only ideas added since midnight (London time) are shown and counted.
  // Earlier days stay in the database and in the presenter's CSV export.
  let london = null;
  function dayStart() {
    const now = new Date();
    try {
      london = london || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      // London wall-clock time at instant t, read as if it were UTC.
      const wall = (t) => { const p = {}; london.formatToParts(t).forEach((x) => { p[x.type] = Number(x.value); }); return p; };
      const offset = (t) => { const p = wall(t); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t.getTime() / 1000) * 1000; };
      const p = wall(now), midnight = Date.UTC(p.year, p.month - 1, p.day);
      // The offset at midnight can differ from the offset now on the days the clocks change.
      return new Date(midnight - offset(new Date(midnight - offset(now))));
    } catch (e) { return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
  }
  const since = (answers, from) => (answers || []).filter((a) => !(Date.parse(a.created_at) < from.getTime()));
  const tally = (answers) => ({ count: answers.length, people: new Set(answers.map((a) => String(a.name || '').trim().toLowerCase())).size });
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  // Legacy anon keys are JWTs and also go in Authorization; new publishable keys (sb_publishable_…) go in apikey only.
  const baseHeaders = { apikey: key, 'content-type': 'application/json' };
  if (/^eyJ/.test(key)) baseHeaders.Authorization = 'Bearer ' + key;
  const headers = (extra) => Object.assign({}, baseHeaders, extra || {});

  async function call(path, opts) {
    opts = opts || {};
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: headers(opts.headers), body: opts.body, cache: 'no-store' });
    if (r.status === 204) return null;
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    if (!r.ok) {
      const msg = (data && (data.message || data.error_description || data.error || data.hint)) || ('Request failed (' + r.status + ')');
      const err = new Error(String(msg).replace(/^P0001:\s*/, '')); err.status = r.status; throw err;
    }
    return data;
  }
  const rpc = (fn, args) => call('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });
  const q = (v) => encodeURIComponent(v);

  // ---- Google Apps Script backend (a Sheet in Drive) ------------------------
  const gsUrl = String(cfg.appsScriptUrl || '').replace(/\/+$/, '');
  if (/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(gsUrl)) {
    const unwrap = async (r) => {
      const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
      if (!data || data.error) { const err = new Error((data && data.error) || ('Request failed (' + r.status + ')')); err.status = r.status || 400; throw err; }
      return data;
    };
    const get = (params) => fetch(gsUrl + '?' + new URLSearchParams(params).toString(), { cache: 'no-store' }).then(unwrap);
    // No content-type header on purpose: a "simple" POST needs no CORS preflight, which Apps Script cannot answer.
    const post = (body) => fetch(gsUrl, { method: 'POST', body: JSON.stringify(body) }).then(unwrap);
    const gsWall = (session) => get({ action: 'wall', session }).then((w) => { const answers = since(w.answers, dayStart()); return Object.assign({ answers }, tally(answers)); });
    window.BuildWall = {
      configured: true,
      list: (session) => gsWall(session).then((w) => w.answers),
      stats: (session) => gsWall(session).then((w) => ({ count: w.count, people: w.people })),
      wall: gsWall,
      add: (row) => post(Object.assign({ action: 'add' }, row)),
      removeOwn: (id, client) => post({ action: 'remove', id, client }).then((r) => r.ok),
      presenterOk: (k) => post({ action: 'presenter_ok', key: k }).then((r) => r.ok === true),
      hide: (k, id) => post({ action: 'hide', key: k, id }).then((r) => r.ok),
      reset: (k, session) => post({ action: 'reset', key: k, session }).then((r) => r.cleared),
      exportRows: (k, session) => post({ action: 'export', key: k, session }).then((r) => r.rows),
      csv: csv, uuid: uuid,
    };
    return;
  }

  // Newest first from the server, so a busy day never cuts off the latest ideas.
  const todays = (session, select) => { const from = dayStart(); return call('/rest/v1/wall?session=eq.' + q(session) + '&created_at=gte.' + q(from.toISOString()) + '&order=created_at.desc&select=' + select + '&limit=1000').then((rows) => since(rows, from)); };

  window.BuildWall = {
    configured,
    list: (session) => todays(session, 'id,name,text,created_at').then((rows) => rows.reverse()),
    stats: (session) => todays(session, 'name,created_at').then(tally),
    add: (row) => call('/rest/v1/answers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) }),
    removeOwn: (id, client) => rpc('remove_own', { p_id: id, p_client: client }),
    presenterOk: (k) => rpc('presenter_ok', { p_key: k }),
    hide: (k, id) => rpc('presenter_hide', { p_key: k, p_id: id }),
    reset: (k, session) => rpc('presenter_reset', { p_key: k, p_session: session }),
    exportRows: (k, session) => rpc('presenter_export', { p_key: k, p_session: session }),
    wall: (session) => window.BuildWall.list(session).then((answers) => Object.assign({ answers }, tally(answers))),
    csv: csv, uuid: uuid,
  };
})();
