// In-memory server speaking the Upstash Redis REST protocol (the subset used by
// the Redis → Supabase migration). Lets the real @upstash/redis client run in
// tests without a network service. Records every command name it receives so
// tests can prove the migration only READS from Redis.
//   POST /            body ["CMD", ...args]        → { result }
//   POST /pipeline    body [["CMD", ...], ...]     → [{ result }, ...]
import http from 'node:http';

export function createStore() {
  const data = new Map(); // key -> { type, value, exp }

  const live = (k) => {
    const e = data.get(k);
    if (e && e.exp && Date.now() >= e.exp) { data.delete(k); return undefined; }
    return e;
  };
  const of = (k, type, init) => {
    let e = live(k);
    if (!e) { e = { type, value: init(), exp: 0 }; data.set(k, e); }
    if (e.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e;
  };
  const get = (k, type) => {
    const e = live(k);
    if (e && e.type !== type) throw new Error('WRONGTYPE');
    return e;
  };
  const num = (s) => (s === '+inf' ? Infinity : s === '-inf' ? -Infinity : Number(String(s).replace(/^\(/, '')));
  const sortedZ = (e) => [...e.value.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const rangeIdx = (len, start, stop) => {
    let s = Number(start); let t = Number(stop);
    if (s < 0) s = Math.max(0, len + s);
    if (t < 0) t = len + t;
    return [s, Math.min(t, len - 1)];
  };

  const cmds = {
    ping: () => 'PONG',
    get: (k) => { const e = get(k, 'string'); return e ? e.value : null; },
    set: (k, v, ...opts) => {
      const o = opts.map((x) => String(x).toLowerCase());
      if (o.includes('nx') && live(k)) return null;
      if (o.includes('xx') && !live(k)) return null;
      let exp = 0;
      const ex = o.indexOf('ex'); if (ex >= 0) exp = Date.now() + Number(opts[ex + 1]) * 1000;
      const px = o.indexOf('px'); if (px >= 0) exp = Date.now() + Number(opts[px + 1]);
      data.set(k, { type: 'string', value: String(v), exp });
      return 'OK';
    },
    getdel: (k) => { const v = cmds.get(k); data.delete(k); return v; },
    del: (...ks) => ks.reduce((n, k) => n + (live(k) ? (data.delete(k), 1) : 0), 0),
    incr: (k) => {
      const e = live(k);
      const n = (e ? Number(e.value) : 0) + 1;
      data.set(k, { type: 'string', value: String(n), exp: e?.exp || 0 });
      return n;
    },
    expire: (k, s) => { const e = live(k); if (!e) return 0; e.exp = Date.now() + Number(s) * 1000; return 1; },
    ttl: (k) => { const e = live(k); if (!e) return -2; return e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1; },
    mget: (...ks) => ks.map((k) => { const e = live(k); return e && e.type === 'string' ? e.value : null; }),
    hset: (k, ...fv) => { const e = of(k, 'hash', () => new Map()); let n = 0; for (let i = 0; i < fv.length; i += 2) { if (!e.value.has(fv[i])) n += 1; e.value.set(fv[i], String(fv[i + 1])); } return n; },
    hget: (k, f) => { const e = get(k, 'hash'); return e?.value.has(f) ? e.value.get(f) : null; },
    hgetall: (k) => { const e = get(k, 'hash'); return e ? [...e.value.entries()].flat() : []; },
    hdel: (k, ...fs) => { const e = get(k, 'hash'); if (!e) return 0; let n = 0; for (const f of fs) if (e.value.delete(f)) n += 1; if (!e.value.size) data.delete(k); return n; },
    sadd: (k, ...ms) => { const e = of(k, 'set', () => new Set()); let n = 0; for (const m of ms) if (!e.value.has(m)) { e.value.add(String(m)); n += 1; } return n; },
    srem: (k, ...ms) => { const e = get(k, 'set'); if (!e) return 0; let n = 0; for (const m of ms) if (e.value.delete(String(m))) n += 1; if (!e.value.size) data.delete(k); return n; },
    sismember: (k, m) => (get(k, 'set')?.value.has(String(m)) ? 1 : 0),
    scard: (k) => get(k, 'set')?.value.size || 0,
    smembers: (k) => [...(get(k, 'set')?.value || [])],
    zadd: (k, ...sm) => { const e = of(k, 'zset', () => new Map()); let n = 0; for (let i = 0; i < sm.length; i += 2) { if (!e.value.has(String(sm[i + 1]))) n += 1; e.value.set(String(sm[i + 1]), Number(sm[i])); } return n; },
    zscore: (k, m) => { const e = get(k, 'zset'); return e?.value.has(String(m)) ? String(e.value.get(String(m))) : null; },
    zrem: (k, ...ms) => { const e = get(k, 'zset'); if (!e) return 0; let n = 0; for (const m of ms) if (e.value.delete(String(m))) n += 1; return n; },
    scan: (cursor, ...opts) => {
      const o = opts.map(String);
      const mi = o.findIndex((x) => x.toLowerCase() === 'match');
      const pattern = mi >= 0 ? o[mi + 1] : '*';
      const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      const rx = new RegExp(`^${escaped}$`);
      return ['0', [...data.keys()].filter((k) => live(k) && rx.test(k))];
    },
    zrange: (k, start, stop, ...opts) => {
      const e = get(k, 'zset'); if (!e) return [];
      const items = sortedZ(e);
      if (opts.map((o) => String(o).toLowerCase()).includes('withscores')) {
        const [s, t] = rangeIdx(items.length, start, stop);
        return items.slice(s, t + 1).flatMap(([m, sc]) => [m, String(sc)]);
      }
      if (opts.map((o) => String(o).toLowerCase()).includes('byscore')) {
        return items.filter(([, s]) => s >= num(start) && s <= num(stop)).map(([m]) => m);
      }
      const [s, t] = rangeIdx(items.length, start, stop);
      return items.slice(s, t + 1).map(([m]) => m);
    },
    zremrangebyscore: (k, min, max) => { const e = get(k, 'zset'); if (!e) return 0; let n = 0; for (const [m, s] of [...e.value]) if (s >= num(min) && s <= num(max)) { e.value.delete(m); n += 1; } return n; },
    zremrangebyrank: (k, start, stop) => {
      const e = get(k, 'zset'); if (!e) return 0;
      const items = sortedZ(e); const [s, t] = rangeIdx(items.length, start, stop);
      const del = items.slice(s, t + 1); del.forEach(([m]) => e.value.delete(m)); return del.length;
    },
    rpush: (k, ...vs) => { const e = of(k, 'list', () => []); e.value.push(...vs.map(String)); return e.value.length; },
    lrange: (k, start, stop) => { const e = get(k, 'list'); if (!e) return []; const [s, t] = rangeIdx(e.value.length, start, stop); return e.value.slice(s, t + 1); },
    lrem: (k, count, v) => {
      const e = get(k, 'list'); if (!e) return 0; let n = 0; const max = Number(count) || Infinity;
      e.value = e.value.filter((x) => { if (x === String(v) && n < max) { n += 1; return false; } return true; });
      if (!e.value.length) data.delete(k); return n;
    },
  };

  const seen = [];
  function exec(command) {
    const [name, ...args] = command;
    seen.push(String(name).toLowerCase());
    const fn = cmds[String(name).toLowerCase()];
    if (!fn) return { error: `ERR unknown command '${name}'` };
    try { return { result: fn(...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))) }; } catch (err) { return { error: err.message }; }
  }

  const snapshot = () => JSON.stringify([...data.entries()].map(([k, e]) => [k, e.type, e.type === 'string' ? e.value : [...e.value]]).sort());
  return { exec, data, seen, snapshot, dump: () => [...data.keys()].filter((k) => live(k)) };
}

export function startMockUpstash() {
  const store = createStore();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '[]');
      let out;
      if (req.url.startsWith('/pipeline') || req.url.startsWith('/multi-exec')) out = payload.map((c) => store.exec(c));
      else out = store.exec(payload);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ store, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
  }));
}
