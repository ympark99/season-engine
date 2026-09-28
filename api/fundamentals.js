// /api/fundamentals — 대장 엔진 재료. Finviz 분기 재무를 유니버스 전종목에 대해 주 1회 조각내서 모으고 점수화한다.
//   GET                      → 수집 상태 + 점수 요약 (공개)
//   GET ?code=BE             → 한 종목 지표·분기 원자료
//   GET ?auto=US&secret=..   → 남은 수집 한 조각 실행 후 스스로 체이닝 (cron)
//   POST {step:'collect'|'score'|'one', m, code, reset}   (관리자)
// 미국 종목만. 한국은 finviz 에 없어서 KIS 추정실적으로 따로 붙일 예정.
import * as store from '../lib/store.js';
import { isAdmin, send, body } from '../lib/service.js';
import { fetchStatement, normalize, metricsAt, rawScores } from '../lib/fundamentals.js';
import { members, listOf, kstDate } from '../lib/universe.js';

const KEY = (m, c) => `fund:${m}:${c}`, S_STATE = m => `fund:state:${m}`, S_SUM = m => `fund:sum:${m}`;
const CHUNK_MS = 40000, GAP_MS = +(process.env.FINVIZ_GAP ?? 350), STALE_DAYS = 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

/** 한 종목 — 손익·현금·재무 세 번 호출 */
export async function collectOne(m, code) {
  const iq = await fetchStatement(code, 'IQ'); await sleep(GAP_MS);
  const cq = await fetchStatement(code, 'CQ'); await sleep(GAP_MS);
  const bq = await fetchStatement(code, 'BQ');
  const rows = normalize({ IQ: iq, CQ: cq, BQ: bq });
  const metrics = metricsAt(rows);
  const rec = { code, m, at: new Date().toISOString(), currency: iq.currency || 'USD', rows, metrics };
  await store.set(KEY(m, code), rec);
  return rec;
}

/** 수집 한 조각 — 오래된 종목부터 */
async function collectChunk(m, { reset = false } = {}) {
  const t0 = Date.now(), today = kstDate();
  let st = await store.get(S_STATE(m));
  if (reset || !st || !st.codes?.length || st.done) {
    const mem = await members(), list = listOf(m, mem);
    if (!list.length) throw new Error('구성종목이 없어 — 유니버스 스캔을 먼저 돌려줘');
    st = { m, started: today, i: 0, codes: list.map(x => x.code), failed: [], done: false };
  }
  const fresh = new Date(Date.now() - STALE_DAYS * 864e5).toISOString();
  let got = 0, skipped = 0;
  while (st.i < st.codes.length && Date.now() - t0 < CHUNK_MS) {
    const code = st.codes[st.i];
    const cur = await store.get(KEY(m, code));
    if (cur?.at > fresh) { skipped++; st.i++; continue; }
    try { await collectOne(m, code); got++; }
    catch (e) { st.failed.push({ code, error: e.message.slice(0, 100) }); if (st.failed.length > 300) st.failed = st.failed.slice(-300); }
    st.i++;
    await sleep(GAP_MS);
  }
  st.done = st.i >= st.codes.length;
  st.updatedAt = new Date().toISOString();
  await store.set(S_STATE(m), st);
  if (st.done) await scoreAll(m);
  return { m, i: st.i, total: st.codes.length, got, skipped, failed: st.failed.length, done: st.done, ms: Date.now() - t0 };
}

const pct = (v, sorted) => {                       // 유니버스 내 백분위 (0~100)
  if (v == null) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return Math.round(100 * lo / Math.max(1, sorted.length - 1));
};

/** 저장된 지표를 유니버스 백분위로 환산해 대장 점수 산출 */
export async function scoreAll(m) {
  const mem = await members(), list = listOf(m, mem), recs = [];
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const got = await store.mget(chunk.map(x => KEY(m, x.code)));
    got.forEach((r, j) => { if (r?.metrics?.ok) recs.push({ ...r, name: chunk[j].name, tags: chunk[j].tags }); });
  }
  if (!recs.length) return { m, n: 0, at: new Date().toISOString(), rows: [] };
  const raw = recs.map(r => ({ r, s: rawScores(r.metrics) }));
  const keys = ['accel', 'growth', 'margin', 'cash', 'quality', 'value', 'risk'];
  const sorted = Object.fromEntries(keys.map(k => [k, raw.map(x => x.s[k]).filter(v => v != null).sort((a, b) => a - b)]));
  const W = { accel: 0.30, growth: 0.15, margin: 0.15, cash: 0.15, quality: 0.10, value: 0.10, risk: 0.05 };
  const rows = raw.map(({ r, s }) => {
    const p = Object.fromEntries(keys.map(k => [k, pct(s[k], sorted[k])]));
    let wsum = 0, acc = 0;
    for (const k of keys) if (p[k] != null) { acc += W[k] * p[k]; wsum += W[k]; }
    const score = wsum ? +(acc / wsum).toFixed(1) : null;
    const M = r.metrics, flags = [];
    if (p.accel != null && p.accel < 20 && (M.dOm ?? 0) < 0) flags.push('이익 정점 경계');      // 정유 매도를 설명하는 규칙
    if (M.funding === '남의 돈' && (M.levEbitda ?? 0) > 3) flags.push('남의 돈 · 레버리지');
    if ((M.dilution ?? 0) > 10) flags.push('희석 10%+');
    if (p.value != null && p.value < 10) flags.push('자기 과거 대비 비쌀');
    if ((M.fcfPos ?? 0) === 4 && (M.dFcfM ?? 0) > 0) flags.push('현금흐름 개선');
    return { code: r.code, name: r.name, tags: (r.tags || []).join('+'), score, p, flags, funding: M.funding,
      q: M.q, asOf: M.asOf, gRev: M.gRev, gEps: M.gEps, accelEps: M.accelEps, accelRev: M.accelRev,
      om: M.om, dOm: M.dOm, fcfM: M.fcfM, roic: M.roic, zPs: M.zPs, lev: M.levEbitda, dilution: M.dilution, noisy: M.noisy };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const sum = { m, at: new Date().toISOString(), n: rows.length, weights: W,
    funding: rows.reduce((a, x) => { a[x.funding || '미상'] = (a[x.funding || '미상'] || 0) + 1; return a; }, {}),
    peak: rows.filter(x => x.flags.includes('이익 정점 경계')).length, rows };
  await store.set(S_SUM(m), sum);
  return sum;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    if (req.method === 'GET' && (req.query.auto === 'US')) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      const r = await collectChunk('US');
      let chained = false;
      const host = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
      if (!r.done && host && process.env.CRON_SECRET) {
        try { await fetch(`${host}/api/fundamentals?auto=US&secret=${encodeURIComponent(process.env.CRON_SECRET)}`, { signal: AbortSignal.timeout(1500) }); chained = true; }
        catch (e) { chained = e.name === 'TimeoutError' || e.name === 'AbortError'; }
      }
      return send(res, 200, { ...r, chained });
    }
    if (req.method === 'GET' && req.query.code) {
      const rec = await store.get(KEY(req.query.m === 'KR' ? 'KR' : 'US', String(req.query.code).toUpperCase()));
      return rec ? send(res, 200, rec) : send(res, 404, { error: '아직 수집 안 된 종목' });
    }
    if (req.method === 'GET') {
      const [sum, st] = await store.mget([S_SUM('US'), S_STATE('US')]);
      const top = sum ? { ...sum, rows: sum.rows.slice(0, 25), bottom: sum.rows.slice(-15).reverse() } : null;
      return send(res, 200, { summary: top, state: st || null });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
    if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
    const b = await body(req), m = b.m === 'KR' ? 'KR' : 'US';
    if (b.step === 'one') return send(res, 200, await collectOne(m, String(b.code).toUpperCase()));
    if (b.step === 'collect') return send(res, 200, await collectChunk(m, { reset: !!b.reset }));
    if (b.step === 'score') return send(res, 200, { ...(await scoreAll(m)), rows: undefined });
    send(res, 400, { error: 'step 은 collect | score | one' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
