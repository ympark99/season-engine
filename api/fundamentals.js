// /api/fundamentals — 대장 엔진 재료. 유니버스 전종목 재무·추정치를 주 1회 조각내서 모으고 점수화한다.
//   GET                      → 수집 상태 + 점수 요약 (공개)
//   GET ?code=BE             → 한 종목 지표·분기 원자료
//   GET ?auto=US|KR&secret=.. → 남은 수집 한 조각 실행 후 스스로 체이닝 (cron)
//   GET ?probe=CODE&m=KR      → 원응답 스키마 확인 (관리자)
//   POST {step:'collect'|'score'|'one', m, code, reset}   (관리자)
// 미국은 Finviz(분기 재무 + 선행 EPS/PER), 국내는 별도 제공처의 추정실적을 쓴다 — 점수 축은 동일.
import * as store from '../lib/store.js';
import { isAdmin, send, body } from '../lib/service.js';
import { fetchStatement, normalize, metricsAt, rawScores } from '../lib/fundamentals.js';
import { fetchForward, blendForward } from '../lib/forward.js';
import { fetchKrInfo, normalizeKr, krMetrics, krRawScores } from '../lib/krfund.js';
import { members, listOf, kstDate } from '../lib/universe.js';

const KEY = (m, c) => `fund:${m}:${c}`, S_STATE = m => `fund:state:${m}`, S_SUM = m => `fund:sum:${m}`;
const CHUNK_MS = 40000, GAP_MS = +(process.env.FINVIZ_GAP ?? 350), STALE_DAYS = 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

/** 한 종목 — 미국은 분기 재무 3회 + 선행 지표 1회, 국내는 추정실적 1회 */
export async function collectOne(m, code) {
  if (m === 'KR') {
    const norm = normalizeKr(await fetchKrInfo(code));
    const metrics = krMetrics(norm);
    const rec = { code, m, at: new Date().toISOString(), currency: 'KRW', kr: norm, metrics };
    await store.set(KEY(m, code), rec);
    return rec;
  }
  const iq = await fetchStatement(code, 'IQ'); await sleep(GAP_MS);
  const cq = await fetchStatement(code, 'CQ'); await sleep(GAP_MS);
  const bq = await fetchStatement(code, 'BQ');
  const rows = normalize({ IQ: iq, CQ: cq, BQ: bq });
  const metrics = metricsAt(rows);
  let fwd = null;
  try { await sleep(GAP_MS); fwd = await fetchForward(code); } catch (e) { fwd = { ok: false, why: e.message.slice(0, 80) }; }   // 선행치는 없어도 진행
  const rec = { code, m, at: new Date().toISOString(), currency: iq.currency || 'USD', rows, metrics, fwd };
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
  const raw = recs.map(r => ({ r, s: m === 'KR' ? krRawScores(r.metrics) : blendForward(rawScores(r.metrics), r.fwd) })).filter(x => x.s);
  const keys = ['accel', 'growth', 'margin', 'cash', 'quality', 'value', 'risk'];
  const sorted = Object.fromEntries(keys.map(k => [k, raw.map(x => x.s[k]).filter(v => v != null).sort((a, b) => a - b)]));
  const W = { accel: 0.30, growth: 0.15, margin: 0.15, cash: 0.15, quality: 0.10, value: 0.10, risk: 0.05 };
  const rows = raw.map(({ r, s }) => {
    const p = Object.fromEntries(keys.map(k => [k, pct(s[k], sorted[k])]));
    let wsum = 0, acc = 0;
    for (const k of keys) if (p[k] != null) { acc += W[k] * p[k]; wsum += W[k]; }
    const score = wsum ? +(acc / wsum).toFixed(1) : null;
    const M = r.metrics, F = r.fwd?.ok ? r.fwd : null, flags = [];
    if (p.accel != null && p.accel < 20 && (M.dOm ?? 0) < 0) flags.push('이익 정점 경계');      // 정유 매도를 설명하는 규칙
    if (M.funding === '남의 돈' && (M.levEbitda ?? 0) > 3) flags.push('남의 돈 · 레버리지');
    if ((M.dilution ?? 0) > 10) flags.push('희석 10%+');
    if (p.value != null && p.value < 10) flags.push('자기 과거 대비 비쌀');
    if ((M.fcfPos ?? 0) === 4 && (M.dFcfM ?? 0) > 0) flags.push('현금흐름 개선');
    if ((M.revUp ?? 0) > 3) flags.push('추정 상향');
    if ((M.revUp ?? 0) < -3) flags.push('추정 하향');
    if ((M.coverage ?? 9) < 3) flags.push('추정 기관 적음');
    return { code: r.code, name: r.name, tags: (r.tags || []).join('+'), score, p, flags, funding: M.funding,
      q: M.q, asOf: M.asOf, gRev: M.gRev, gEps: M.gEps, accelEps: M.accelEps, accelRev: M.accelRev,
      om: M.om, dOm: M.dOm, fcfM: M.fcfM, roic: M.roic ?? M.roeFwd, zPs: M.zPs, lev: M.levEbitda, dilution: M.dilution, noisy: M.noisy,
      fwdEps: M.fwdEps ?? F?.epsNextY ?? null, fwdPe: M.fwdPe ?? F?.fwdPe ?? null,
      gEpsFwd: M.gEpsFwd ?? F?.gEpsNextY ?? null, revUp: M.revUp ?? null, rs: M.rs ?? null,
      target: F?.target ?? null, upside: F?.upside ?? null };
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
    if (req.method === 'GET' && (req.query.auto === 'US' || req.query.auto === 'KR')) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      const m = req.query.auto, r = await collectChunk(m);
      let chained = false, next = null;
      const host = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
      if (host && process.env.CRON_SECRET) {
        next = !r.done ? `/api/fundamentals?auto=${m}` : `/api/portfolio?auto=${m}`;      // 수집이 끝나면 예시 포트폴리오 갱신
        try { await fetch(`${host}${next}&secret=${encodeURIComponent(process.env.CRON_SECRET)}`, { signal: AbortSignal.timeout(1500) }); chained = true; }
        catch (e) { chained = e.name === 'TimeoutError' || e.name === 'AbortError'; }
      }
      return send(res, 200, { ...r, chained, next });
    }
    if (req.method === 'GET' && req.query.probe) {                                        // 원응답 확인 (스키마 점검용)
      if (!admin) return send(res, 401, { error: '관리자 키가 필요해' });
      const code = String(req.query.probe);
      if ((req.query.m || 'KR') === 'KR') { const j = await fetchKrInfo(code); return send(res, 200, { keys: Object.keys(j?.data || j || {}), norm: normalizeKr(j), metrics: krMetrics(normalizeKr(j)) }); }
      return send(res, 200, await fetchForward(code.toUpperCase()));
    }
    if (req.method === 'GET' && req.query.code) {
      const m = req.query.m === 'KR' ? 'KR' : 'US';
      const rec = await store.get(KEY(m, m === 'KR' ? String(req.query.code) : String(req.query.code).toUpperCase()));
      return rec ? send(res, 200, rec) : send(res, 404, { error: '아직 수집 안 된 종목' });
    }
    if (req.method === 'GET') {
      const m = req.query.m === 'KR' ? 'KR' : 'US';
      const [sum, st] = await store.mget([S_SUM(m), S_STATE(m)]);
      const top = sum ? { ...sum, rows: sum.rows.slice(0, 25), bottom: sum.rows.slice(-15).reverse() } : null;
      return send(res, 200, { summary: top, state: st || null, m });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
    if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
    const b = await body(req), m = b.m === 'KR' ? 'KR' : 'US';
    if (b.step === 'one') return send(res, 200, await collectOne(m, m === 'KR' ? String(b.code) : String(b.code).toUpperCase()));
    if (b.step === 'collect') return send(res, 200, await collectChunk(m, { reset: !!b.reset }));
    if (b.step === 'score') return send(res, 200, { ...(await scoreAll(m)), rows: undefined });
    send(res, 400, { error: 'step 은 collect | score | one' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
