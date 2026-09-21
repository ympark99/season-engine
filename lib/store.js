// 저장소 — Upstash Redis REST (Vercel Marketplace 의 Upstash 연동이 넣어주는 환경변수 사용). 외부 패키지 없음.
// 로컬 테스트: STORE_FILE=경로 를 주면 JSON 파일로 대체.
import fs from 'node:fs';

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function cmd(...args) {
  if (process.env.STORE_FILE) return fileCmd(args);
  if (!URL_ || !TOKEN) throw new Error('Redis 미연결 — Vercel Storage 에서 Upstash Redis 를 연결해줘');
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error(`Redis ${args[0]}: ${j.error}`);
  return j.result;
}

/* ---------- 로컬 파일 대체 (테스트용) ---------- */
function fileCmd([c, ...a]) {
  const f = process.env.STORE_FILE, db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const now = Date.now(), live = k => db[k] && (!db[k].exp || db[k].exp > now) ? db[k].v : null;
  let out = null;
  switch (c.toUpperCase()) {
    case 'GET': out = live(a[0]); break;
    case 'MGET': out = a.map(live); break;
    case 'SET': {
      const nx = a.includes('NX'), ex = a.indexOf('EX');
      if (nx && live(a[0]) != null) { out = null; break; }
      db[a[0]] = { v: a[1], exp: ex > 0 ? now + a[ex + 1] * 1000 : 0 }; out = 'OK'; break;
    }
    case 'DEL': a.forEach(k => delete db[k]); out = a.length; break;
    case 'HSET': { const h = live(a[0]) || {}; for (let i = 1; i < a.length; i += 2) h[a[i]] = a[i + 1]; db[a[0]] = { v: h }; out = 1; break; }
    case 'HDEL': { const h = live(a[0]) || {}; a.slice(1).forEach(k => delete h[k]); db[a[0]] = { v: h }; out = 1; break; }
    case 'HGETALL': { const h = live(a[0]) || {}; out = Object.entries(h).flat(); break; }
    default: throw new Error('unsupported ' + c);
  }
  fs.writeFileSync(f, JSON.stringify(db));
  return out;
}

const J = x => (x == null ? null : typeof x === 'string' ? JSON.parse(x) : x);

export const get = async k => J(await cmd('GET', k));
export const set = (k, v, ex) => (ex ? cmd('SET', k, JSON.stringify(v), 'EX', ex) : cmd('SET', k, JSON.stringify(v)));
export const setNX = (k, v, ex) => cmd('SET', k, JSON.stringify(v), 'NX', 'EX', ex);
export const del = (...k) => cmd('DEL', ...k);
export const mget = async keys => (keys.length ? (await cmd('MGET', ...keys)).map(J) : []);

/* 목록: hash list  field = "US:VLO"  value = {m,code,name,excd,addedAt} */
export async function listAll() {
  const flat = (await cmd('HGETALL', 'list')) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push(J(flat[i + 1]));
  return out;
}
export const listPut = it => cmd('HSET', 'list', `${it.m}:${it.code}`, JSON.stringify(it));
export const listDel = (m, code) => cmd('HDEL', 'list', `${m}:${code}`);

/* 일봉: bars:US:VLO = {d:[], c:[], v:[]} */
export const barsKey = (m, code) => `bars:${m}:${code}`;
export const getBars = (m, code) => get(barsKey(m, code));
export const setBars = (m, code, b) => set(barsKey(m, code), b);
export const mgetBars = items => mget(items.map(x => barsKey(x.m, x.code)));

export async function ping() { try { await cmd('SET', 'ping', '1', 'EX', 60); return true; } catch { return false; } }
