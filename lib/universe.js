// 유니버스(S&P500·나스닥100 / 코스피200·코스닥150) 매일 전종목 판정.
// 검색으로 추가하는 내 목록(list)과는 별개 — 여기는 자동으로만 돌고, 화면에는 분포와 '오늘 바뀐 종목'으로 나옴.
import * as store from './store.js';
import { refresh, engineState, KEEP } from './service.js';
import { analyze, SEASONS } from './engine.js';
import { fetchUniverse } from './masters.js';

export const UNIV_SETS = { US: ['SPX', 'NDX'], KR: ['K200', 'KQ150'] };
export const SET_NAME = { SPX: 'S&P 500', NDX: '나스닥 100', K200: '코스피 200', KQ150: '코스닥 150' };
const MEM_KEY = 'univ:members', MEM_TTL = 7 * 864e5;
export const kstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

/** 구성종목 — Redis 에 7일 캐시. 새로 못 받으면 옛 캐시라도 씀 */
export async function members({ force = false } = {}) {
  const cur = await store.get(MEM_KEY);
  if (!force && cur && Date.now() - Date.parse(cur.at) < MEM_TTL) return cur;
  try {
    const got = await fetchUniverse();
    if (!Object.keys(got.sets).length) throw new Error(got.errors.join(' / ') || '구성종목 0');
    await store.set(MEM_KEY, got);
    return got;
  } catch (e) {
    if (cur) return { ...cur, errors: [...(cur.errors || []), `갱신 실패(옛 목록 사용): ${e.message}`] };
    throw e;
  }
}

/** 시장별 대상 종목 — 두 지수를 합치고 중복 제거, 어느 지수에 들었는지 tag 로 표시 */
export function listOf(m, mem) {
  const by = new Map();
  for (const key of UNIV_SETS[m]) for (const x of mem.sets?.[key] || []) {
    const k = x.code, cur = by.get(k);
    if (cur) cur.tags.push(key); else by.set(k, { ...x, tags: [key] });
  }
  return [...by.values()].sort((a, b) => a.code.localeCompare(b.code));
}

const stateKey = m => `univ:state:${m}`, resKey = m => `univ:res:${m}`, prevKey = m => `univ:prev:${m}`;
export const dailyKey = m => `univ:daily:${m}`, histKey = m => `univ:hist:${m}`;

/** 배치 한 번: 남은 종목을 시간 예산만큼 갱신·판정. 끝나면 분포와 국면 변경 목록을 만들어 저장 */
export async function scanBatch(m, { budgetMs = 45000, reset = false } = {}) {
  const t0 = Date.now(), today = kstDate();
  const mem = await members();
  const list = listOf(m, mem);
  if (!list.length) throw new Error(`${m} 구성종목을 못 받았어 — ${(mem.errors || []).join(' / ')}`);
  let st = await store.get(stateKey(m));
  if (reset || !st || st.date !== today) st = { date: today, i: 0, failed: [], startedAt: new Date().toISOString() };
  let res = st.i ? await store.get(resKey(m)) : null;
  if (!res || res.date !== today) res = { date: today, rows: {} };

  const eng = await engineState();
  let n = 0;
  while (st.i < list.length && Date.now() - t0 < budgetMs) {
    const it = list[st.i], item = { m, code: it.code, name: it.name, excd: it.excd || null };
    try {
      const { bars, excd } = await refresh(item);
      const { summary } = analyze(bars, eng.params, eng.cal, KEEP);
      res.rows[it.code] = { n: it.name, t: it.tags.join('+'), x: excd || null, s: summary.season, p: summary.prob,
        e: summary.entry, g: summary.age, d5: summary.ps5, c: summary.last, r: summary.sinceEntry, dd: summary.dd, ld: summary.lastDate };
    } catch (e) {
      st.failed.push({ code: it.code, error: e.message.slice(0, 120) });
      if (st.failed.length > 400) st.failed = st.failed.slice(-400);
    }
    st.i++; n++;
  }
  const done = st.i >= list.length;
  await store.set(resKey(m), res);
  await store.set(stateKey(m), { ...st, done, updatedAt: new Date().toISOString() });
  let daily = null;
  if (done) daily = await finish(m, res, st, list.length);
  return { m, date: today, i: st.i, total: list.length, scanned: n, failed: st.failed.length, done, ms: Date.now() - t0, daily };
}

/** 스캔 완료 — 분포, 전일 대비 국면 변경, 확률 변화 큰 종목 */
async function finish(m, res, st, total) {
  const prev = await store.get(prevKey(m));
  const rows = res.rows, codes = Object.keys(rows);
  const cnt = Object.fromEntries(SEASONS.map(s => [s, 0]));
  for (const c of codes) cnt[rows[c].s]++;
  const n = codes.length || 1;
  const pct = Object.fromEntries(SEASONS.map(s => [s, +(100 * cnt[s] / n).toFixed(1)]));
  const changes = [], moves = [];
  if (prev?.rows) {
    for (const c of codes) {
      const a = prev.rows[c], b = rows[c];
      if (!a) continue;
      if (a.s !== b.s) changes.push({ code: c, name: b.n, tag: b.t, from: a.s, to: b.s, prob: b.p, was: a.p });
      else if (Math.abs(b.p - a.p) >= 10) moves.push({ code: c, name: b.n, tag: b.t, s: b.s, from: a.p, to: b.p });
    }
    changes.sort((x, y) => SEASONS.indexOf(x.to) - SEASONS.indexOf(y.to) || y.prob - x.prob);
    moves.sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from));
  }
  const bySet = {};
  for (const key of UNIV_SETS[m]) {
    const sub = codes.filter(c => rows[c].t.includes(key));
    if (!sub.length) continue;
    const cc = Object.fromEntries(SEASONS.map(s => [s, sub.filter(c => rows[c].s === s).length]));
    bySet[key] = { n: sub.length, cnt: cc, bull: +(100 * (cc['봄'] + cc['여름']) / sub.length).toFixed(1) };
  }
  const daily = {
    asof: res.date, at: new Date().toISOString(), m, n, total, failed: st.failed.slice(0, 40), failedN: st.failed.length,
    cnt, pct, bull: +(pct['봄'] + pct['여름']).toFixed(1), bySet,
    prevAsof: prev?.date || null, changes: changes.slice(0, 120), changesN: changes.length,
    moves: moves.slice(0, 40), movesN: moves.length,
  };
  await store.set(dailyKey(m), daily);
  await store.set(prevKey(m), { date: res.date, rows });                       // 다음 날 비교 기준
  const hist = (await store.get(histKey(m))) || [];
  const rec = { asof: daily.asof, cnt, pct, bull: daily.bull, n, changes: changes.length };
  await store.set(histKey(m), [...hist.filter(h => h.asof !== rec.asof), rec].slice(-120));
  return daily;
}

/** 다음 배치를 스스로 호출 — 응답은 안 기다리고 요청만 띄움 (Vercel 함수 60초 제한 우회) */
export async function chain(m) {
  const host = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!host || !process.env.CRON_SECRET) return false;
  try { await fetch(`${host}/api/universe?scan=${m}&secret=${encodeURIComponent(process.env.CRON_SECRET)}`, { signal: AbortSignal.timeout(1500) }); }
  catch (e) { if (e.name !== 'TimeoutError' && e.name !== 'AbortError') return false; }
  return true;
}

/** 스캔이 끝나면 그 날짜 기준 신뢰도도 다시 측정 (실패해도 스캔 결과에는 영향 없음) */
export async function chainBacktest(m) {
  const host = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!host || !process.env.CRON_SECRET) return false;
  try {
    await fetch(`${host}/api/backtest`, { method: 'POST', signal: AbortSignal.timeout(1500),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CRON_SECRET}` },
      body: JSON.stringify({ m, step: 'run', sample: 250 }) });
  } catch (e) { if (e.name !== 'TimeoutError' && e.name !== 'AbortError') return false; }
  return true;
}

/** 스캔 진행 상태 (화면 표시용) */
export async function scanState(m) {
  const [st, daily] = await store.mget([stateKey(m), dailyKey(m)]);
  return { state: st || null, daily: daily || null };
}
