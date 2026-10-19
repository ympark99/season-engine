// 미국 옵션 수급 — CBOE 지연 시세 옵션 체인(무료 · 키 없음 · 장중 약 15분 지연)을 받아 서버에서 지표를 계산한다.
// 원본 체인(종목당 ~1MB)은 저장하지 않고, 요약만 저장:
//   opt:US:{code}  = 최신 요약(sum) — 상세 화면 캐시 (장중 15분 · 장 밖 3시간)
//   opth:US:{code} = 날짜별 기록 [{d, px, flip, gex, ..., oiK?}] — 매일 장 마감 뒤 cron(op=opt)이 한 줄씩 (최근 260일, 행사가별 미결제약정 oiK 는 최근 5일만)
//   opt:sum:US     = 종목별 한 줄 요약 {code: {d, px, flip, gex, cp, ...}} — 목록 태그·시장 국면 (SPY·QQQ)
// 지표: 감마 플립(주가를 바꿔가며 BS 감마로 Net GEX 가 0 이 되는 가격) · Net GEX(1% 움직임당 딜러 감마 달러, 콜 +, 풋 −)
//       콜 월·풋 월(감마가 가장 큰 행사가 — 전체 만기·가까운 만기) · 맥스 페인 · 풋/콜(거래량·미결제약정·프리미엄) · 예상 변동폭(가까운 만기 ATM 스트래들)
import * as store from './store.js';
import { rowOf, featOf, saveDay, DKEY, rulesView } from './optsig.js';

const URL0 = s => `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(s)}.json`;
export const OPT_KEEP = 260, OI_KEEP = 5;
export const OKEY = c => `opt:US:${c}`, HKEY = c => `opth:US:${c}`, SKEY = 'opt:sum:US';
export const MKT_OPT = ['SPY', 'QQQ'];                                         // 시장 국면 — 지수 ETF 체인

/** 미국 정규장(대략 13:30~20:15 UTC, 서머타임 차이는 넉넉히) 안이면 true */
export function usOpen(now = new Date()) {
  const d = now.getUTCDay(), m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return d >= 1 && d <= 5 && m >= 13 * 60 + 25 && m <= 21 * 60 + 5;
}

export async function fetchChain(code) {
  const r = await fetch(URL0(code), { headers: { 'User-Agent': 'Mozilla/5.0 season-engine', Accept: 'application/json' }, redirect: 'follow' });
  if (r.status === 403 || r.status === 404) { const e = new Error(`옵션 없음 또는 접근 거부 (${r.status})`); e.status = 404; throw e; }   // CBOE 는 없는 종목에 403 을 줌
  if (!r.ok) throw new Error(`CBOE ${r.status}`);
  return r.json();
}

const r2 = x => +x.toFixed(2), px2 = x => (x == null ? null : +x.toFixed(x >= 100 ? 1 : 2));
const ncdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function bsGamma(s, K, t, iv) {
  if (!(iv > 0) || !(t > 0)) return 0;
  const v = iv * Math.sqrt(t), d1 = (Math.log(s / K) + 0.5 * iv * iv * t) / v;
  return ncdf(d1) / (s * v);
}

/** CBOE 체인 JSON → 요약. 계약 코드: {SYM}{YYMMDD}{C|P}{행사가×1000 8자리} */
export function optSummary(j, code) {
  const D = j?.data; if (!D?.options?.length) return null;
  const S = D.close || D.current_price, asof = String(D.last_trade_time || j.timestamp || '').slice(0, 10);
  const T0 = Date.parse(asof + 'T00:00:00Z');
  const rows = [];
  for (const x of D.options) {
    const k = x.option.slice(-15), y = 2000 + +k.slice(0, 2), exp = `${y}-${k.slice(2, 4)}-${k.slice(4, 6)}`, cp = k[6], K = +k.slice(7) / 1000;
    const dte = Math.round((Date.parse(exp + 'T00:00:00Z') - T0) / 864e5);
    if (dte < 0) continue;
    const mid = x.ask > 0 ? (x.bid + x.ask) / 2 : x.last_trade_price || 0;
    rows.push({ exp, dte, cp, K, oi: x.open_interest || 0, v: x.volume || 0, g: x.gamma || 0, iv: x.iv || 0, mid, last: x.last_trade_price || 0, sym: x.option });
  }
  if (!rows.length || !(S > 0)) return null;
  const exps = [...new Set(rows.map(r => r.exp))].sort(), near = exps[0];
  const gx = r => r.g * r.oi * 100 * S * S * 0.01;                             // 1% 움직임당 감마 달러
  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
  const C = rows.filter(r => r.cp === 'C'), P = rows.filter(r => r.cp === 'P');
  const vC = sum(C, r => r.v), vP = sum(P, r => r.v), oC = sum(C, r => r.oi), oP = sum(P, r => r.oi);
  const pC = sum(C, r => r.v * r.mid * 100), pP = sum(P, r => r.v * r.mid * 100);
  const gC = sum(C, gx), gP = sum(P, gx);
  const maxPain = R => { const Ks = [...new Set(R.map(r => r.K))]; let best = null, bv = Infinity;
    for (const X of Ks) { const v = sum(R, r => r.oi * (r.cp === 'C' ? Math.max(0, X - r.K) : Math.max(0, r.K - X))); if (v < bv) { bv = v; best = X; } } return best; };
  const wall = (R, cp) => { const m = new Map(); for (const r of R) if (r.cp === cp) m.set(r.K, (m.get(r.K) || 0) + gx(r)); let b = null, bv = 0; for (const [K, v] of m) if (v > bv) { bv = v; b = K; } return b; };
  // 감마 플립 — 지금가 ±50% 를 0.5% 간격으로 Net GEX 재계산, 부호가 바뀌는 곳 중 지금가에 가장 가까운 곳
  const live = rows.filter(r => r.oi > 0 && r.iv > 0);
  const net = s => { let t = 0; for (const r of live) { const g = bsGamma(s, r.K, Math.max(r.dte, 0.5) / 365, r.iv) * r.oi * 100 * s * s * 0.01; t += r.cp === 'C' ? g : -g; } return t; };
  const grid = []; for (let i = 0; i <= 200; i++) grid.push(S * (0.5 + 0.005 * i));
  const nv = grid.map(net); let flip = null;
  for (let i = 0; i < grid.length - 1; i++) if ((nv[i] < 0) !== (nv[i + 1] < 0)) {
    const s = grid[i] + (grid[i + 1] - grid[i]) * (nv[i] / (nv[i] - nv[i + 1]));
    if (flip == null || Math.abs(s - S) < Math.abs(flip - S)) flip = s;
  }
  // 만기별
  const byExp = exps.map(e => {
    const R = rows.filter(r => r.exp === e), Rc = R.filter(r => r.cp === 'C'), Rp = R.filter(r => r.cp === 'P');
    const atmK = R.reduce((b, r) => (b == null || Math.abs(r.K - S) < Math.abs(b - S) ? r.K : b), null);
    const ac = Rc.find(r => r.K === atmK), ap = Rp.find(r => r.K === atmK);
    const ivs = [ac?.iv, ap?.iv].filter(v => v > 0);
    return { d: e, dte: R[0].dte, vC: sum(Rc, r => r.v), vP: sum(Rp, r => r.v), oC: sum(Rc, r => r.oi), oP: sum(Rp, r => r.oi),
      pC: Math.round(sum(Rc, r => r.v * r.mid * 100)), pP: Math.round(sum(Rp, r => r.v * r.mid * 100)),
      mp: maxPain(R), iv: ivs.length ? r2(100 * ivs.reduce((a, b) => a + b, 0) / ivs.length) : null, em: ac?.mid > 0 && ap?.mid > 0 ? px2(ac.mid + ap.mid) : null };
  });
  const N = rows.filter(r => r.exp === near), nE = byExp[0];
  const emE = byExp.find(e => e.dte >= 1 && e.em) || nE;                       // 예상 변동폭 — 당일 만기는 건너뛰고 다음 만기 ATM 스트래들
  // 행사가별 (차트·막대용) — 지금가 ±45% 안
  const strikes = (R) => { const m = new Map();
    for (const r of R) { if (r.K < S * 0.55 || r.K > S * 1.45) continue; const o = m.get(r.K) || [r.K, 0, 0, 0, 0, 0, 0]; const i = r.cp === 'C' ? 0 : 1;
      o[1 + i] += gx(r); o[3 + i] += r.oi; o[5 + i] += r.v; m.set(r.K, o); }
    return [...m.values()].sort((a, b) => a[0] - b[0]).map(o => [o[0], Math.round(o[1]), Math.round(o[2]), o[3], o[4], o[5], o[6]]); };
  const oiK = {}; for (const r of rows) { if (r.K < S * 0.5 || r.K > S * 1.5) continue; const o = oiK[r.K] || (oiK[r.K] = [0, 0]); o[r.cp === 'C' ? 0 : 1] += r.oi; }
  const top = [...rows].filter(r => r.v > 0).sort((a, b) => b.v - a.v).slice(0, 10).map(r => ({ exp: r.exp, cp: r.cp, K: r.K, v: r.v, oi: r.oi, x: r.oi > 0 ? r2(r.v / r.oi) : null, prem: Math.round(r.v * r.mid * 100), iv: r.iv ? r2(r.iv * 100) : null, mid: px2(r.mid) }));
  const iv30 = D.iv30 ? r2(D.iv30) : null;
  return {
    code, d: asof, at: j.timestamp || null, px: r2(S), chg: D.price_change_percent != null ? r2(D.price_change_percent) : null, iv30,
    vol: [vC, vP], oi: [oC, oP], prem: [Math.round(pC), Math.round(pP)],
    pcV: vC ? r2(vP / vC) : null, pcO: oC ? r2(oP / oC) : null, cpP: pC + pP ? Math.round(100 * pC / (pC + pP)) : null,   // cpP = 콜 프리미엄 비중(%)
    gex: Math.round(gC - gP), gexC: Math.round(gC), gexP: Math.round(gP), flip: px2(flip),
    cw: wall(rows, 'C'), pw: wall(rows, 'P'), cwN: wall(N, 'C'), pwN: wall(N, 'P'),
    mp: maxPain(rows), mpN: nE.mp, near, em: emE.em, emD: emE.d, emPct: emE.em ? r2(100 * emE.em / S) : null,
    exps: byExp, strikes: strikes(rows), strikesN: strikes(N), top, oiK, n: rows.length,
  };
}

/** 목록·시장 국면용 한 줄 — 날짜별 기록에도 이 칸 그대로 (+ oiK) */
export const lineOf = s => ({ d: s.d, px: s.px, flip: s.flip, gex: s.gex, cpP: s.cpP, pcV: s.pcV, pcO: s.pcO, cw: s.cw, pw: s.pw, cwN: s.cwN, pwN: s.pwN, mp: s.mp, mpN: s.mpN,
  em: s.em, emPct: s.emPct, iv30: s.iv30, vol: s.vol[0] + s.vol[1], prem: s.prem[0] + s.prem[1], oiT: s.oi });

/** 날짜별 기록에 오늘 줄을 넣는다 (같은 날이면 바꿈) — oiK 는 최근 OI_KEEP 일만 */
export function pushHist(h, s) {
  const a = (h || []).filter(x => x.d !== s.d);
  a.push({ ...lineOf(s), oiK: s.oiK });
  a.sort((x, y) => (x.d < y.d ? -1 : 1));
  const out = a.slice(-OPT_KEEP);
  for (let i = 0; i < out.length - OI_KEEP; i++) delete out[i].oiK;
  return out;
}

/** 기록 → 사건(플립 회복·이탈, GEX 부호 전환, 콜 월 이동) · 20일 평균 · 전날 대비 미결제약정 변화 상위 */
export function derive(sum, hist) {
  const H = (hist || []).filter(x => x.d < sum.d);                              // 오늘 이전
  const prev = H[H.length - 1] || null, ev = [];
  const all = [...H, lineOf(sum)];
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    if (a.flip != null && b.flip != null) {
      if (a.px < a.flip && b.px >= b.flip) ev.push({ d: b.d, k: 'up', t: '플립 회복', why: `종가 ${b.px}가 감마 플립 ${b.flip} 위로` });
      if (a.px >= a.flip && b.px < b.flip) ev.push({ d: b.d, k: 'dn', t: '플립 이탈', why: `종가 ${b.px}가 감마 플립 ${b.flip} 아래로` });
    }
    if (a.gex != null && b.gex != null && (a.gex < 0) !== (b.gex < 0)) ev.push({ d: b.d, k: b.gex >= 0 ? 'up' : 'dn', t: b.gex >= 0 ? 'GEX 양전' : 'GEX 음전', why: `Net GEX ${Math.round(a.gex / 1e6)}M → ${Math.round(b.gex / 1e6)}M` });
    if (a.cw != null && b.cw != null && b.cw !== a.cw) ev.push({ d: b.d, k: b.cw > a.cw ? 'up' : 'dn', t: b.cw > a.cw ? '콜 월 상향' : '콜 월 하향', why: `콜 월 ${a.cw} → ${b.cw}` });
  }
  const last20 = H.slice(-20), avg = k => { const v = last20.map(x => x[k]).filter(x => x != null); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  let oiChg = null;
  if (prev?.oiK && sum.oiK) {
    const ch = [];
    for (const K of new Set([...Object.keys(prev.oiK), ...Object.keys(sum.oiK)])) {
      const a = prev.oiK[K] || [0, 0], b = sum.oiK[K] || [0, 0];
      if (b[0] !== a[0]) ch.push({ K: +K, cp: 'C', dv: b[0] - a[0], now: b[0] });
      if (b[1] !== a[1]) ch.push({ K: +K, cp: 'P', dv: b[1] - a[1], now: b[1] });
    }
    ch.sort((x, y) => Math.abs(y.dv) - Math.abs(x.dv));
    const tot = c => ch.filter(x => x.cp === c).reduce((s, x) => s + x.dv, 0);
    oiChg = { from: prev.d, top: ch.slice(0, 10), dC: tot('C'), dP: tot('P') };
  }
  return { ev: ev.slice(-12).reverse(), avg20: { cpP: avg('cpP'), pcV: avg('pcV'), vol: avg('vol'), prem: avg('prem'), n: last20.length }, oiChg };
}

/** 오늘 특징 (lib/optsig.js featOf) — 날짜별 기록(h, 오늘 줄 포함 가능)에서 전날·20일 평균을 찾아서 */
export function featNow(sum, h) {
  const H = (h || []).filter(x => x.d < sum.d), p = H[H.length - 1];
  const prev = p && Date.parse(sum.d) - Date.parse(p.d) <= 5 * 864e5 ? { px: p.px, fl: p.flip, gx: p.gex, cp: p.cpP, cw: p.cw, oc: p.oiT?.[0], op: p.oiT?.[1] } : null;
  const cps = H.slice(-20).map(x => x.cpP).filter(v => v != null);
  return featOf(rowOf(sum), prev, cps.length >= 5 ? cps.reduce((a, b) => a + b, 0) / cps.length : null);
}

/** 한 종목 받아서 계산·저장 (save=true 면 날짜별 기록에도) — 내 종목용 */
export async function refreshOpt(code, { save = false } = {}) {
  const s = optSummary(await fetchChain(code), code);
  if (!s) throw new Error('옵션 체인이 비어 있어');
  await store.set(OKEY(code), { sum: s, got: Date.now() }, usOpen() ? 15 * 60 : 3 * 3600);
  let h = null;
  if (save) { h = pushHist(await store.get(HKEY(code)), s); await store.set(HKEY(code), h); }
  return { s, h };
}

/** 상세 화면 — 캐시가 있으면 그대로, 없으면 지금 받음. 기록·사건·변화·오늘 특징·옵션 신호 규칙(검증 상태) 같이 */
export async function optFor(code) {
  const [c, h] = await store.mget([OKEY(code), HKEY(code)]);
  let sum = c?.sum || null, err = null;
  if (!sum) { try { sum = (await refreshOpt(code)).s; } catch (e) { err = e.message; } }
  if (!sum) return { error: err || '옵션 데이터 없음' };
  const hist = (h || []).map(x => { const { oiK, ...r } = x; return r; });
  return { sum: { ...sum, oiK: undefined }, hist, ...derive(sum, h), feat: featNow(sum, h), sig: await rulesView() };
}

/** 매일 장 마감 뒤 — SPY·QQQ + 내 목록 미국 종목(자세히: 날짜별 기록·한 줄 요약) + 유니버스(압축 한 줄만 optd:{날짜}).
 *  날짜 = 체인의 마지막 거래일. 이미 그 날짜에 받은 종목은 건너뜀 (예비 크론이 이어서) */
export async function snapshotAll(mine, univ = [], budgetMs = 240000) {
  const t0 = Date.now(), my = [...new Set([...MKT_OPT, ...mine])], uv = [...new Set(univ)].filter(c => !my.includes(c));
  const sumMap = (await store.get(SKEY)) || {}, fail = {};
  let D = null, day = {}, got = {}, done = 0;
  const fresh = async () => { const s0 = optSummary(await fetchChain('SPY'), 'SPY'); return s0?.d; };
  try { D = await fresh(); } catch (e) { return { error: 'SPY 체인 실패: ' + e.message }; }
  day = (await store.get(DKEY(D))) || {};
  const todo = [...my.map(c => [c, 1]), ...uv.map(c => [c, 0])].filter(([c]) => !day[c] && sumMap[c]?.none !== D);
  for (let i = 0; i < todo.length; i += 6) {
    if (Date.now() - t0 > budgetMs) break;
    await Promise.all(todo.slice(i, i + 6).map(async ([c, mineF]) => {
      try {
        if (mineF) { const { s, h } = await refreshOpt(c, { save: true }); sumMap[c] = { ...lineOf(s), f: featNow(s, h), got: D }; got[c] = rowOf(s); }
        else { const s = optSummary(await fetchChain(c), c); if (s) got[c] = rowOf(s); }
        done++;
      } catch (e) { fail[c] = e.message.slice(0, 60); if (e.status === 404) sumMap[c] = { ...(sumMap[c] || {}), none: D }; }
    }));
    if (Object.keys(got).length >= 120) { await saveDay(D, got); got = {}; }        // 중간 저장 (시간 초과 대비)
  }
  await saveDay(D, got);
  await store.set(SKEY, sumMap);
  const now = (await store.get(DKEY(D))) || {};
  return { d: D, mine: my.length, univ: uv.length, done, have: Object.keys(now).length, left: [...my, ...uv].filter(c => !now[c] && sumMap[c]?.none !== D).length, fail: Object.keys(fail).length, failSample: Object.fromEntries(Object.entries(fail).slice(0, 8)), ms: Date.now() - t0 };
}
