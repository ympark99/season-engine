// /api/portfolio — 전략실 (8개 전략 × 미국·한국). 매일 파이프라인 끝단에서 새 거래일만 이어 붙인다.
//   GET ?m=US                → 전략 8개 요약 + 벤치마크 + 장세
//   GET ?m=US&s=S1           → 전략 하나 상세 (보유·매매 내역 전체·일별 평가금액·벤치마크 곡선)
//   POST {step:'run', m, reset}  (관리자) — 지금 이어 돌리기 / reset 이면 장부를 지우고 오늘(최근 거래일)부터 다시 시작
// 시장 지표 3종(mkt:ind:{m})과 국면 효과 유니버스 기준선(mkt:eff:{m})도 같은 데이터로 여기서 계산한다.
import * as store from '../lib/store.js';
import { engineState, isAdmin, send, body, KEEP } from '../lib/service.js';
import { Series } from '../lib/engine.js';
import { classifyOf } from '../lib/engine2.js';
import { STRATS, CAPITAL, prepItem, runDays, summaryOf, periodsOf, newBook } from '../lib/portfolio.js';
import { pbScan, mcOpt } from '../lib/pullback.js';
import { marketIndicators } from '../lib/indicators.js';
import { universeEffect, effectOf } from '../lib/effect.js';
import { historyOf } from '../lib/history.js';
import { members, listOf, kstDate, sectorMap } from '../lib/universe.js';

const SUM = m => `strat:${m}`, BOOK = (m, id) => `strat:${m}:${id}`;
const BENCH = { US: [['COMP', '나스닥'], ['SPX', 'S&P 500']], KR: [['KOSPI', '코스피'], ['KOSDAQ', '코스닥']] };
const RAW = 'https://raw.githubusercontent.com/ympark99/season-engine/main/public/data/';
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

async function loadMany(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 25) out.push(...(await store.mget(keys.slice(i, i + 25))));
  return out;
}
async function getJson(name) {
  try { const r = await fetch(RAW + name, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** 매크로 위험도 기록 — macro.json 의 risk[m] (−2 매우 위험 ~ +2 우호). 매일 오늘 값을 쌓아 과거 날짜에도 그날 값을 쓴다 */
async function macroHistory(m, macro) {
  const key = `macro:hist:${m}`, hist = (await store.get(key)) || {};
  const r = macro?.risk?.[m];
  if (typeof r === 'number' && isFinite(r)) {
    const d = (macro.asof || kstDate()).slice(0, 10);
    if (hist[d] !== r) { hist[d] = Math.max(-2, Math.min(2, r)); await store.set(key, hist); }
  }
  return hist;
}

/** 전략 실행에 필요한 데이터 묶음 */
async function build(m, books) {
  const mem = await members(), list = listOf(m, mem);
  if (!list.length) throw new Error('구성종목이 없어 — 유니버스 스캔을 먼저 돌려줘');
  const names = Object.fromEntries(list.map(x => [x.code, x.name]));
  for (const b of Object.values(books)) for (const p of Object.values(b?.pos || {})) if (!names[p.code]) names[p.code] = p.name;    // 유니버스에서 빠진 보유 종목도 가격은 계속 본다
  const codes = Object.keys(names);
  const [bars, recs, eng, sum, sectors, macro, catsJ, MC] = await Promise.all([
    loadMany(codes.map(c => store.barsKey(m, c))), loadMany(codes.map(c => `fund:${m}:${c}`)), engineState(), store.get(`fund:sum:${m}`),
    sectorMap(m, names), getJson('macro.json'), getJson('categories.json'), store.get(`mcap:${m}`),
  ]);
  const items = [];
  codes.forEach((code, k) => {
    const b = bars[k];
    if (!b?.d?.length || b.d.length < 300) return;
    items.push(prepItem({ code, name: names[code], sector: sectors[code] || null, s: new Series(b.d, b.c, b.v), rows: recs[k]?.rows || null, kr: recs[k]?.kr || null }, eng.params, eng.cal));
  });
  for (const x of items) x.pb = new Map(pbScan(x.s, mcOpt(m, MC, x.code)).ent.map(e => [e.t, e]));   // 8호 눌림매매 — 날짜 인덱스 → 눌림 진입
  for (const x of items) {                                          // 계절 적합도 (상세 화면 맨 위 태그와 같은 판정) — 6호 대상 선정
    try { const A = { s: x.s, season: x.season }; x.fit = effectOf(A, historyOf(A, eng.cal, KEEP), null, KEEP).fit; } catch { x.fit = null; }
  }
  if (items.length < 30) throw new Error(`일봉이 있는 종목이 ${items.length}개뿐이야 — 유니버스 스캔이 끝난 뒤 돌려줘`);
  // 거래일 축 — 종목의 절반 이상이 봉을 가진 날만 (휴장일·한두 종목만 있는 날 제외). 장부가 없으면 최근 거래일 하루만(= 오늘 시작)
  const cnt = new Map(); for (const x of items) for (const d of x.s.d.slice(-30)) cnt.set(d, (cnt.get(d) || 0) + 1);
  const all = [...cnt.keys()].filter(d => cnt.get(d) >= items.length * 0.5).sort();
  const lasts = STRATS.map(st => books[st.id]?.last).filter(Boolean);
  const after = lasts.length ? lasts.reduce((a, b) => (a < b ? a : b)) : null;   // 새로 추가된 전략은 다음 거래일부터 합류
  const days = after ? all.filter(d => d > after) : all.slice(-1);
  // 지수 국면 (장세)
  const ixBars = await store.mget(BENCH[m].map(([c]) => store.barsKey('IX', c)));
  const ix = ixBars.map(b => (b?.d?.length ? { s: new Series(b.d, b.c, b.v), b } : null)).map(o => (o ? { ...o, season: classifyOf(o.s, eng.params) } : null));
  const idxSeasons = D => ix.map(o => { if (!o) return null; const i = o.s.at(D); return i >= 0 ? o.season[i] : null; });

  // 매크로 위험도 (기록이 있는 날만, 7일 넘게 묵은 값은 안 씀)
  const mh = await macroHistory(m, macro), mdates = Object.keys(mh).sort();
  const macroOf = D => { let k = -1; for (let i = 0; i < mdates.length && mdates[i] <= D; i++) k = i; if (k < 0) return null; const d = mdates[k]; return (Date.parse(D) - Date.parse(d)) / 864e5 <= 7 ? { risk: mh[d], d } : null; };

  // 매크로 범주 뷰 → 종목별 (4호 가감용)
  const views = Object.fromEntries((macro?.categories || []).map(c => [c.key, c.view]));
  const cats = {}; for (const [k, v] of Object.entries(catsJ?.map || {})) { const [mm, code] = k.split(':'); if (mm === m && views[v]) cats[code] = views[v]; }

  // 대장 점수 — 그날 대시보드 점수 그대로 (14일 넘게 묵었으면 안 씀 → 대장을 쓰는 전략은 현금)
  const fresh = sum?.at && Date.now() - Date.parse(sum.at) < 14 * 864e5;
  const live = fresh ? { fund: new Map(sum.rows.filter(r => r.score != null).map(r => [r.code, r])) } : null;
  return { m, items, axis: days, idxSeasons, macroOf, cats, live, sectors, ix, macroNow: macro?.risk?.[m] ?? null, lastBar: all[all.length - 1] };
}

/** 이어서 돌리고 저장 */
export async function run(m, { reset = false } = {}) {
  const t0 = Date.now();
  const books = {};
  if (!reset) {
    const got = await store.mget(STRATS.map(st => BOOK(m, st.id)));
    STRATS.forEach((st, i) => { if (got[i]?.daily) books[st.id] = got[i]; });
  }
  const data = await build(m, books);
  const done = runDays(data, books);
  for (const st of STRATS) if (!books[st.id]) books[st.id] = newBook(null);    // 오늘 새로 추가된 전략 — 다음 거래일부터 합류 (빈 장부로 저장)
  for (const st of STRATS) await store.set(BOOK(m, st.id), books[st.id]);

  // 벤치마크 — 전략과 같은 날짜로 맞춘 1,000만원 곡선
  const ref = books.S1.daily.map(x => x[0]);
  const benches = BENCH[m].map(([code, name], k) => {
    const o = data.ix[k]; if (!o) return { code, name, missing: true };
    if (!ref.length) return { code, name, missing: true };
    const i0 = o.s.at(ref[0]); if (i0 < 0) return { code, name, missing: true };
    const c0 = o.s.p[i0], series = ref.map(d => { const i = o.s.at(d); return [d, Math.round(CAPITAL * o.s.p[Math.max(i, 0)] / c0)]; });
    return { code, name, periods: periodsOf(series), cum: +(100 * (series[series.length - 1][1] / CAPITAL - 1)).toFixed(2) };
  });
  const lastRegime = done.length ? done[done.length - 1].regime : books.S1.regime || null;
  const out = { m, at: new Date().toISOString(), start: books.S1.start || ref[0] || null, capital: CAPITAL, asof: books.S1.last, processed: done.length, ms: Date.now() - t0,
    regime: lastRegime, macro: data.macroNow, live: !!data.live, liveScoreAt: data.live ? 'fund' : null,
    strategies: STRATS.map(st => summaryOf(st, books[st.id], m)), benches };
  await store.set(SUM(m), out);
  // 시장 지표 3종 — 하루 한 번
  try {
    const [cur, eff] = await store.mget([`mkt:ind:${m}`, `mkt:eff:${m}`]);
    if (!cur || cur.asof !== data.lastBar || reset) { const ind = marketIndicators(data.items, data.sectors); if (ind) await store.set(`mkt:ind:${m}`, { ...ind, at: new Date().toISOString() }); }
    if (!eff || eff.asof !== data.lastBar || reset)      // 국면 효과 유니버스 기준선
      await store.set(`mkt:eff:${m}`, { ...universeEffect(data.items, KEEP), asof: data.lastBar, at: new Date().toISOString() });
  } catch { /* 지표 실패는 전략 결과에 영향 없음 */ }
  return { ...out, strategies: out.strategies.map(s => ({ id: s.id, cum: s.cum, nHold: s.nHold })) };
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    const m = (req.query.m || '').toUpperCase() === 'KR' ? 'KR' : 'US';
    if (req.method === 'GET' && (req.query.auto === 'US' || req.query.auto === 'KR')) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      return send(res, 200, await run(req.query.auto));
    }
    if (req.method === 'GET' && req.query.s) {
      const st = STRATS.find(x => x.id === req.query.s);
      if (!st) return send(res, 404, { error: '없는 전략' });
      const [book, sum] = await store.mget([BOOK(m, st.id), SUM(m)]);
      if (!book) return send(res, 200, { empty: true, m });
      const ixb = await store.mget(BENCH[m].map(([c]) => store.barsKey('IX', c)));
      const dates = book.daily.map(x => x[0]);
      const curves = BENCH[m].map(([code, name], k) => {
        const b = ixb[k]; if (!b?.d?.length || !dates.length) return { code, name, series: [] };
        const s = new Series(b.d, b.c, b.v), i0 = s.at(dates[0]); if (i0 < 0) return { code, name, series: [] };
        return { code, name, series: dates.map(d => { const i = s.at(d); return Math.round(CAPITAL * s.p[Math.max(0, i)] / s.p[i0]); }) };
      });
      return send(res, 200, { m, summary: summaryOf(st, book, m), regime: book.regime || null, dates, eq: book.daily.map(x => x[1]), inv: book.daily.map(x => x[2]),
        benches: curves, trades: [...book.trades].reverse(), at: sum?.at || null });
    }
    if (req.method === 'GET') {
      const r = await store.get(SUM(m));
      return send(res, 200, r || { empty: true, m });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
    if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
    const b = await body(req), mm = b.m === 'KR' ? 'KR' : 'US';
    if (b.step === 'run') return send(res, 200, await run(mm, { reset: !!b.reset }));
    send(res, 400, { error: "step 은 'run'" });
  } catch (e) { send(res, 500, { error: e.message }); }
}
