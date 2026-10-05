// 미국 컨센서스 (연간 EPS·매출 추정 평균·최저·최고·애널리스트 수) — 주소는 lib/sources.js.
// EPS 는 정상화(non-GAAP) 기준이라 재무제표 GAAP EPS 와 섞어 성장률을 내지 않는다 (추정치끼리 비교).
// 종목 id 는 한 번 찾으면 Redis 에 저장 (est:ids:US). 추정치는 여러 종목을 한 번에 받는다.
import * as store from './store.js';
import { US_EST as B, US_EST_REF as REF, UA, usEstHeaders } from './sources.js';

const ITEMS = ['eps_normalized_consensus_mean', 'eps_normalized_num_of_estimates', 'eps_normalized_consensus_low', 'eps_normalized_consensus_high',
  'revenue_consensus_mean', 'revenue_num_of_estimates', 'revenue_consensus_low', 'revenue_consensus_high'];
const SHORT = { eps_normalized_consensus_mean: 'eps', eps_normalized_num_of_estimates: 'epsN', eps_normalized_consensus_low: 'epsLo', eps_normalized_consensus_high: 'epsHi',
  revenue_consensus_mean: 'rev', revenue_num_of_estimates: 'revN', revenue_consensus_low: 'revLo', revenue_consensus_high: 'revHi' };
const IDS_KEY = 'est:ids:US';

async function getJson(path, { timeoutMs = 15000 } = {}) {
  const r = await fetch(B + path, { headers: { 'user-agent': UA, accept: 'application/json', referer: REF, ...usEstHeaders() }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`컨센서스 HTTP ${r.status}`); e.status = r.status; e.body = text.slice(0, 200); throw e; }
  try { return JSON.parse(text); } catch { const e = new Error('컨센서스 응답이 JSON 이 아님'); e.body = text.slice(0, 200); throw e; }
}

/** 티커 → 제공처 종목 id (검색 결과에서 /symbol/TICKER 와 정확히 같은 것만) */
export async function searchId(ticker) {
  const t = String(ticker).toUpperCase();
  const j = await getJson(`searches?filter[query]=${encodeURIComponent(t)}&filter[type]=symbols&filter[list]=all&filter[period]=all&page[size]=6&page[number]=1`);
  const hit = (j.symbols || []).find(x => String(x.url || '').toUpperCase() === `/SYMBOL/${t}`)
    || (j.symbols || []).find(x => String(x.name || '').replace(/<[^>]*>/g, '').toUpperCase() === t);
  return hit ? +hit.id : null;
}

/** 저장된 id 표 — 없는 것만 찾아서 채운다 (시간 예산 안에서). 못 찾은 티커는 0 으로 기록해 다시 안 찾음 */
export async function idsFor(tickers, { budgetMs = 30000, gapMs = 2500 } = {}) {
  const t0 = Date.now(), ids = (await store.get(IDS_KEY)) || {};
  let added = 0;
  for (const t of tickers) {
    if (ids[t] !== undefined) continue;
    if (Date.now() - t0 > budgetMs) break;
    try { ids[t] = (await searchId(t)) || 0; added++; }
    catch (e) { if (e.status === 403 || e.status === 429) { await store.set(BLOCK_KEY, { at: new Date().toISOString(), status: e.status }, 6 * 3600); break; } }
    await new Promise(r => setTimeout(r, gapMs));
  }
  if (added) await store.set(IDS_KEY, ids);
  return ids;
}

/** 여러 id 의 연간 추정치 (relative 1 = 아직 발표 안 된 첫 회계연도, 2 = 그다음, 3 = 그다음) */
export async function fetchEstimates(idList) {
  const q = `symbol_data/estimates?estimates_data_items=${ITEMS.join('%2C')}&period_type=annual&relative_periods=1%2C2%2C3&ticker_ids=${idList.join('%2C')}`;
  const j = await getJson(q), out = {};
  for (const id of idList) {
    const src = j.estimates?.[id];
    if (!src) continue;
    const by = {};
    for (const [item, per] of Object.entries(src)) {
      const k = SHORT[item];
      if (!k) continue;
      for (const [rel, arr] of Object.entries(per || {})) {
        const x = Array.isArray(arr) ? arr[arr.length - 1] : null;
        if (!x) continue;
        const row = by[rel] || (by[rel] = { rel: +rel, fy: x.period?.fiscalyear ?? null, end: String(x.period?.periodenddate || '').slice(0, 10) || null });
        const v = parseFloat(x.dataitemvalue);
        row[k] = Number.isFinite(v) ? (k.startsWith('rev') && !k.endsWith('N') ? +(v / 1e6).toFixed(1) : v) : null;   // 매출은 백만 달러
      }
    }
    out[id] = Object.values(by).sort((a, b) => a.rel - b.rel);
  }
  return out;
}

/** 추정치 → 점수에 쓰는 요약. price 는 우리 일봉 종가 */
export function summarize(years, price) {
  const [y1, y2, y3] = years || [];
  if (!y1?.eps) return { ok: false };
  const pe = y => (y?.eps > 0 && price > 0 ? +(price / y.eps).toFixed(2) : null);
  const spread = y => (y?.eps > 0 && y.epsHi != null && y.epsLo != null ? +(100 * (y.epsHi - y.epsLo) / y.eps).toFixed(1) : null);
  return {
    ok: true, price: price ?? null,
    fy1: y1.fy, fy2: y2?.fy ?? null, eps1: y1.eps, eps2: y2?.eps ?? null, eps3: y3?.eps ?? null,
    pe1: pe(y1), pe2: pe(y2), pe3: pe(y3),
    g12: y1.eps > 0 && y2?.eps != null ? +(100 * (y2.eps / y1.eps - 1)).toFixed(1) : null,                // EPS 성장 FY+1→FY+2 (추정끼리)
    g23: y2?.eps > 0 && y3?.eps != null ? +(100 * (y3.eps / y2.eps - 1)).toFixed(1) : null,
    rev1: y1.rev ?? null, rev2: y2?.rev ?? null, gRev12: y1.rev > 0 && y2?.rev != null ? +(100 * (y2.rev / y1.rev - 1)).toFixed(1) : null,
    spread1: spread(y1), n1: y1.epsN ?? null, n2: y2?.epsN ?? null, years,
  };
}

const EST_KEY = 'est:US', HIST_KEY = 'est:hist:US', BLOCK_KEY = 'est:block:US';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 묶음 요청이 400 이면 반으로 나눠 다시 (묶음 한도·문제 id 를 피해서). 끝까지 400 인 id 는 빈 결과 */
async function fetchSplit(idList, gapMs) {
  try { return await fetchEstimates(idList); }
  catch (e) {
    if (e.status !== 400 || idList.length === 1) { if (e.status === 400) return { [idList[0]]: [] }; throw e; }
    const h = Math.ceil(idList.length / 2), a = await fetchSplit(idList.slice(0, h), gapMs);
    await sleep(gapMs);
    return { ...a, ...(await fetchSplit(idList.slice(h), gapMs)) };
  }
}
const kst = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

/** 하루 한 번 — 대상 종목 전부의 연간 추정치를 받아 저장 (est:US) + 주 1회 EPS 기록 (est:hist:US, 추정 상향/하향용 · 용량 때문에 주 단위 20개).
 *  이미 오늘 받은 종목은 건너뛰니 여러 번 불러도 된다. 요청 사이 6초 · 20종목씩 (3초 간격으로 25번쯤 보내면 차단됐다).
 *  막히면(403·429) 그 자리에서 멈추고 6시간 쉰다. */
export async function collectEstimates(tickers, { budgetMs = 60000, chunk = 20, gapMs = 6000 } = {}) {
  const t0 = Date.now(), today = kst();
  const blocked = await store.get(BLOCK_KEY);
  if (blocked) return { got: 0, blocked };                                         // 막힌 뒤 6시간은 쉬어서 차단이 풀리게 둔다
  const ids = await idsFor(tickers, { budgetMs: budgetMs * 0.6, gapMs });
  const [cur, hist] = await store.mget([EST_KEY, HIST_KEY]);
  const rows = cur?.rows || {}, H = hist || {};
  const todo = tickers.filter(t => ids[t] > 0 && rows[t]?.d !== today);
  let got = 0, error = null;
  for (let i = 0; i < todo.length; i += chunk) {
    if (Date.now() - t0 > budgetMs) break;
    const part = todo.slice(i, i + chunk), byId = Object.fromEntries(part.map(t => [ids[t], t]));
    try {
      const res = await fetchSplit(part.map(t => ids[t]), gapMs);
      for (const [id, years] of Object.entries(res)) {
        const t = byId[id];
        if (!t) continue;
        rows[t] = { d: today, y: years };
        const y1 = years[0], y2 = years[1];
        const last = (H[t] || []).at(-1);
        if (y1?.eps != null && (!last || Date.parse(today) - Date.parse(last[0]) >= 6.5 * 864e5)) H[t] = [...(H[t] || []), [today, y1.fy, y1.eps, y2?.eps ?? null]].slice(-20);
        got++;
      }
      for (const t of part) if (!res[ids[t]]) rows[t] = { d: today, y: [] };        // 추정치가 없는 종목 (ETF 등)
    } catch (e) {
      error = e.message;
      if (e.status === 403 || e.status === 429) { await store.set(BLOCK_KEY, { at: new Date().toISOString(), status: e.status }, 6 * 3600); break; }
    }
    await sleep(gapMs);
  }
  if (got || todo.length) await store.set(EST_KEY, { at: new Date().toISOString(), rows });
  if (got) await store.set(HIST_KEY, H);
  const noId = tickers.filter(t => ids[t] === 0).length, noIdYet = tickers.filter(t => ids[t] === undefined).length;
  return { got, left: tickers.filter(t => ids[t] > 0 && rows[t]?.d !== today).length, noId, noIdYet, error, ms: Date.now() - t0 };
}

export const loadEstimates = async () => { const [e, h] = await store.mget([EST_KEY, HIST_KEY]); return { rows: e?.rows || {}, hist: h || {}, at: e?.at || null }; };

/** 30일 전 대비 FY+1 EPS 추정 변화(%). now = {d, fy, eps}. 회계연도가 넘어갔으면 그때의 FY+2 와 비교 */
export function revisionOf(h, now, days = 30) {
  if (!h?.length || !now?.eps) return null;
  const cut = new Date(Date.parse(now.d) - days * 864e5).toISOString().slice(0, 10);
  const old = [...h].reverse().find(x => x[0] <= cut);
  if (!old) return null;
  const base = old[1] === now.fy ? old[2] : old[1] + 1 === now.fy ? old[3] : null;
  return base > 0 ? +(100 * (now.eps / base - 1)).toFixed(1) : null;
}

/** 대장 점수의 선행 지표 형식(fwd)으로 — lib/forward.js blendForward 가 그대로 쓴다 */
export function estForward(row, hist, price) {
  if (!row?.y?.length) return null;
  const s = summarize(row.y, price);
  if (!s.ok) return null;
  return { ok: true, src: 'est', price, epsNextY: s.eps1, fwdPe: s.pe1, gEpsNextY: s.g12, gEpsThisY: null,
    eps2: s.eps2, pe2: s.pe2, pe3: s.pe3, fy1: s.fy1, fy2: s.fy2, g23: s.g23, gRev12: s.gRev12, spread1: s.spread1, n1: s.n1,
    revUp: revisionOf(hist, { d: row.d, fy: s.fy1, eps: s.eps1 }), d: row.d };
}
