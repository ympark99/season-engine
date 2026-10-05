// /api/fundamentals — 대장 엔진 재료. 유니버스 전종목 재무·추정치를 주 1회 조각내서 모으고 점수화한다.
//   GET                      → 수집 상태 + 점수 요약 (공개)
//   GET ?code=BE             → 한 종목 지표·분기 원자료
//   GET ?all=1&m=US          → 점수 전체 목록 (대시보드 표)
//   GET ?auto=US|KR&secret=.. → 남은 수집 한 조각 실행 (파이프라인이 부름)
//   GET ?probe=CODE&m=KR      → 원응답 스키마 확인 (관리자)
//   POST {step:'collect'|'score'|'one', m, code, reset}   (관리자)
// 미국은 분기 재무 + 선행 EPS/PER, 국내는 추정실적을 쓴다 — 점수 축은 동일. 제공처 이름은 코드·화면에 쓰지 않는다.
import * as store from '../lib/store.js';
import { isAdmin, send, body } from '../lib/service.js';
import { fetchStatement, normalize, metricsAt, rawScores } from '../lib/fundamentals.js';
import { fetchForward, blendForward } from '../lib/forward.js';
import { fetchKrInfo, normalizeKr, krMetrics, krRawScores, epsSnapshot } from '../lib/krfund.js';
import { members, listOf, kstDate } from '../lib/universe.js';
import { sectorOf } from '../lib/sectors.js';
import { loadSecOvr } from '../lib/themes.js';
import { krStockInfo } from '../lib/kis.js';

/** 수집·점수 대상 — 유니버스 전종목 + 유니버스에 없는 내 목록 종목 (검색으로 추가한 종목도 대장 점수가 나오게) */
async function targetsOf(m) {
  const [mem, mine] = await Promise.all([members(), store.listAll()]);
  const list = listOf(m, mem), have = new Set(list.map(x => x.code));
  for (const it of mine) if (it?.m === m && !have.has(it.code)) { list.push({ code: it.code, name: it.name, tags: ['내 목록'] }); have.add(it.code); }
  return list;
}

const KEY = (m, c) => `fund:${m}:${c}`, S_STATE = m => `fund:state:${m}`, S_SUM = m => `fund:sum:${m}`;
const CHUNK_MS = 35000, GAP_MS = +(process.env.FUND_GAP ?? 350), STALE_DAYS = 7;
const staleDays = m => (m === 'KR' ? 3 : STALE_DAYS);    // 국내는 추정 변화 기록을 촘촘히 쌓으려고 3일마다
const sleep = ms => new Promise(r => setTimeout(r, ms));
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

/** 한 종목 — 미국은 분기 재무 3회 + 선행 지표 1회, 국내는 컨센서스 연간·분기 2회 */
export async function collectOne(m, code) {
  if (m === 'KR') {
    const [prev, bars] = await store.mget([KEY(m, code), store.barsKey('KR', code)]);
    const norm = normalizeKr(await fetchKrInfo(code));
    const snap = epsSnapshot(norm);
    const hist = [...(prev?.hist || []).filter(h => h.d !== snap.d), snap].slice(-60);        // 추정 EPS 기록 (추정 상향/하향 계산용)
    const price = bars?.c?.length ? bars.c[bars.c.length - 1] : null;
    const metrics = krMetrics(norm, { price, hist });
    let secRaw = prev?.secRaw || null, secAt = prev?.secAt || null;            // 업종명은 60일에 한 번만 KIS 에서 받는다
    if (!secAt || Date.now() - Date.parse(secAt) > 60 * 864e5) {
      try { const si = await krStockInfo(code); secRaw = si.std || si.idx || secRaw; secAt = new Date().toISOString(); } catch { /* 섹터는 없어도 진행 */ }
    }
    const rec = { code, m, at: new Date().toISOString(), currency: 'KRW', kr: norm, hist, metrics, secRaw, secAt };
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

/** 수집 한 조각 — 오래된 종목부터.
 *  한 바퀴가 끝나면 STALE_DAYS 가 지나기 전에는 다시 돌지 않는다.
 *  (예전엔 끝나자마자 다음 호출에서 진행 0/N 으로 새 바퀴를 시작해서, 화면에선 수집한 게 날아간 것처럼 보였다) */
export async function collectChunk(m, { reset = false } = {}) {
  const t0 = Date.now(), today = kstDate();
  let st = await store.get(S_STATE(m));
  const cycleOld = st?.done && st.finishedAt && Date.now() - Date.parse(st.finishedAt) > (st.blocked ? 20 * 3600e3 : staleDays(m) * 864e5);   // 막혔던 바퀴는 다음 날 다시 시도
  if (st?.done && !reset && !cycleOld) return { m, i: st.i, total: st.codes.length, ...(await catchUp(m, t0)), skipped: 0, failed: st.failed.length, done: true, idle: true, ms: Date.now() - t0 };
  if (reset || !st || !st.codes?.length || st.done) {
    const list = await targetsOf(m);
    if (!list.length) throw new Error('구성종목이 없어 — 유니버스 스캔을 먼저 돌려줘');
    st = { m, started: today, i: 0, codes: list.map(x => x.code), failed: [], done: false, prevN: st?.collected ?? null };
  }
  const fresh = new Date(Date.now() - staleDays(m) * 864e5).toISOString();
  let got = 0, skipped = 0;
  while (st.i < st.codes.length && Date.now() - t0 < CHUNK_MS) {
    const code = st.codes[st.i];
    const cur = await store.get(KEY(m, code));
    if (cur?.at > fresh && !reset) { skipped++; st.i++; continue; }
    try { await collectOne(m, code); got++; }
    catch (e) { st.failed.push({ code, error: e.message.slice(0, 140) }); if (st.failed.length > 300) st.failed = st.failed.slice(-300); }
    st.i++;
    await sleep(GAP_MS);
    // 국내 제공처가 통째로 막힌 경우 — 첫 10종목이 전부 같은 이유로 실패하면 그 바퀴를 멈추고 이유를 남긴다
    if (m === 'KR' && st.i === 10 && st.failed.length >= 10) { st.blocked = st.failed[0].error; break; }
  }
  st.done = st.i >= st.codes.length || !!st.blocked;
  st.updatedAt = new Date().toISOString();
  if (st.done) {
    st.finishedAt = st.updatedAt;
    const sum = await scoreAll(m);
    st.collected = sum.n;
  }
  await store.set(S_STATE(m), st);
  return { m, i: st.i, total: st.codes.length, got, skipped, failed: st.failed.length, done: st.done, blocked: st.blocked || null, ms: Date.now() - t0 };
}

/** 바퀴 사이 쉬는 동안 — 새로 추가했는데 아직 재료가 없는 내 목록 종목만 바로 모으고 점수를 다시 낸다 */
async function catchUp(m, t0) {
  const list = await targetsOf(m);
  const recs = await store.mget(list.map(x => KEY(m, x.code)));
  const need = list.filter((x, i) => !recs[i] && x.tags?.includes('내 목록'));
  let got = 0;
  for (const x of need) {
    if (Date.now() - t0 > CHUNK_MS) break;
    try { await collectOne(m, x.code); got++; } catch { /* 다음 호출 때 다시 */ }
    await sleep(GAP_MS);
  }
  if (got) await scoreAll(m);
  return { got, catchUp: need.length };
}

const pct = (v, sorted) => {                       // 유니버스 내 백분위 (0~100)
  if (v == null) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  let up = lo;
  while (up < sorted.length && sorted[up] === v) up++;                              // 같은 값은 가운데 순위 (동점이 전부 0%가 되지 않게)
  const rank = up > lo ? (lo + up - 1) / 2 : lo;
  return Math.round(100 * rank / Math.max(1, sorted.length - 1));
};

/** 저장된 지표를 유니버스 백분위로 환산해 대장 점수 산출 */
export async function scoreAll(m) {
  const list = await targetsOf(m), recs = [];
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const got = await store.mget(chunk.map(x => KEY(m, x.code)));
    got.forEach((r, j) => { if (r?.metrics?.ok) recs.push({ ...r, name: chunk[j].name, tags: chunk[j].tags }); });
  }
  if (!recs.length) { const prev = await store.get(S_SUM(m)); return prev || { m, n: 0, at: new Date().toISOString(), rows: [] }; }   // 수집이 전부 실패해도 이전 점수는 지우지 않음
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
    if (p.value != null && p.value < 10) flags.push('자기 과거 대비 비쌈');
    if ((M.fcfPos ?? 0) === 4 && (M.dFcfM ?? 0) > 0) flags.push('현금흐름 개선');
    if ((M.revUp ?? 0) > 3) flags.push('추정 상향');
    if ((M.revUp ?? 0) < -3) flags.push('추정 하향');
    if ((M.surOp ?? 0) >= 5) flags.push('어닝 서프라이즈');
    if ((M.surOp ?? 0) <= -5) flags.push('어닝 쇼크');
    if (M.basis === 'trailing') flags.push('추정치 없음 · 실적 기준');
    if (M.loss) flags.push('적자(PER 없음)');
    if (M.consol === 'P') flags.push('별도 기준');
    const sector = sectorOf(m, r.code, { name: r.name, collected: m === 'KR' ? r.secRaw : r.fwd?.industry });
    return { code: r.code, name: r.name, tags: (r.tags || []).join('+'), sector, score, p, flags, funding: M.funding,
      q: M.q, asOf: M.asOf, gRev: M.gRev, gEps: M.gEps, accelEps: M.accelEps, accelRev: M.accelRev,
      om: M.om, dOm: M.dOm, fcfM: M.fcfM, roic: M.roic ?? M.roeFwd, zPs: M.zPs, lev: M.levEbitda, dilution: M.dilution, noisy: M.noisy,
      fwdEps: M.fwdEps ?? F?.epsNextY ?? null, fwdPe: M.fwdPe ?? F?.fwdPe ?? null,
      gEpsFwd: M.gEpsFwd ?? F?.gEpsNextY ?? null, revUp: M.revUp ?? null, rs: M.rs ?? null,
      surOp: M.surOp ?? null, surQ: M.surQ ?? null, peBasis: M.basis ?? null, gOp: M.gOp ?? null, gOpNext: M.gOpNext ?? null, epsNext: M.epsNext ?? null, debtRatio: M.debtRatio ?? null,
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
      return send(res, 200, await collectChunk(req.query.auto));
    }
    if (req.method === 'GET' && req.query.probe) {                                        // 원응답 확인 (스키마 점검용)
      if (!admin) return send(res, 401, { error: '관리자 키가 필요해' });
      const code = String(req.query.probe);
      if ((req.query.m || 'KR') === 'KR') { const n = normalizeKr(await fetchKrInfo(code)); return send(res, 200, { norm: n, metrics: krMetrics(n) }); }
      return send(res, 200, await fetchForward(code.toUpperCase()));
    }
    if (req.method === 'GET' && req.query.code) {
      const m = req.query.m === 'KR' ? 'KR' : 'US', code = m === 'KR' ? String(req.query.code) : String(req.query.code).toUpperCase();
      const [rec, sum] = await store.mget([KEY(m, code), S_SUM(m)]);
      const scored = sum?.rows?.find(r => r.code === code) || null;
      return rec || scored ? send(res, 200, { ...(rec || {}), scored, rank: scored ? sum.rows.indexOf(scored) + 1 : null, of: sum?.n ?? null }) : send(res, 404, { error: '아직 수집 안 된 종목' });
    }
    if (req.method === 'GET') {
      const m = req.query.m === 'KR' ? 'KR' : 'US';
      const [sum, st] = await store.mget([S_SUM(m), S_STATE(m)]);
      if (sum?.rows) { const so = await loadSecOvr(m); for (const r of sum.rows) if (so[r.code]) r.sector = so[r.code]; }   // 직접 지정한 세부 업종
      const state = st ? { i: st.i, total: st.codes?.length ?? null, done: st.done, started: st.started, updatedAt: st.updatedAt, finishedAt: st.finishedAt || null,
        collected: st.collected ?? null, failedN: st.failed?.length || 0, failed: (st.failed || []).slice(-5), blocked: st.blocked || null,
        next: st.finishedAt ? new Date(Date.parse(st.finishedAt) + (st.blocked ? 864e5 : staleDays(m) * 864e5)).toISOString().slice(0, 10) : null } : null;
      if (req.query.all) return send(res, 200, { summary: sum || null, state, m });
      const top = sum ? { ...sum, rows: sum.rows.slice(0, 25), bottom: sum.rows.slice(-15).reverse() } : null;
      return send(res, 200, { summary: top, state, m });
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
