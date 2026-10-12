// 지지·저항선 — 최근 1년 일봉(시가·고가·저가·종가)에서 차트 매물대를 찾는다.
//   미국: 차트 제공처의 일봉 API (주소는 lib/sources.js), 국내: KIS 일봉(시가·고가·저가 포함).
//   전종목이 아니라 눌림목 후보·내 목록만 하루 한 번 받는다 — 일봉 OHLC 는 저장하지 않고 결과(선 몇 개)만 남긴다.
//
// 계산
//   ATR(14)            평균 하루 변동폭 — 선 묶음 간격·손절 여유폭의 단위
//   스윙 고점/저점      좌우 5봉 안에서 가장 높은(낮은) 봉. 고점·저점을 가격대별로 묶어(0.75 ATR 안) 터치 수가 많고 최근일수록 강한 선
//   상승 추세선         스윙 저점 두 개(뒤쪽이 더 높음)를 이은 선 중 그 사이 저가가 선 아래로 거의 안 내려간 가장 긴 선
//   1년 최고가          위쪽에 매물대가 없으면(신고가권) 저항 없음으로 둔다
//
// 미국은 차트 제공처가 그려 주는 선(patterns)을 우선 쓴다 — 응답의 선은 차트 그림 좌표라 날짜·가격으로 바꿔야 한다.
//   x: 0~600, 1봉 = 3px, x=600 이 마지막 봉 (200봉 창)   y: 0~300, 위가 patternsMaxRange · 아래가 patternsMinRange (선형)
//   (LITE 로 맞춤: 7/29 저점 594.8 ↔ x443·y199 → 603, 5/12 고점 ↔ x280, 수평선 y133 → 801)
//   kind 1 = 수평 지지·저항, 2 = 위쪽 추세선, 3 = 아래쪽 추세선, 그 밖(삼각형·쐐기 등)은 두 변(x1y1-x2y2, x3y3-x4y4)을 선으로 본다.
//   지금 가격보다 아래면 지지, 위면 저항. 선이 없거나 좌표가 이상하면 직접 계산한 선으로 대신한다.
import * as store from './store.js';
import { US_CHART, US_CHART_REF, UA } from './sources.js';
import { krOhlc } from './kis.js';

export const LV = { k: 5, tol: 0.75, keep: 3, tlMin: 20, slack: 0.3, pad: 0.5, maxLoss: 8 };
const KEY = (m, c) => `lv:${m}:${c}`, BLOCK = 'lv:block:US';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = t => new Date(t * 1000).toISOString().slice(0, 10);
const r4 = x => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));

/** 미국 일봉 OHLC 1년 — 응답 { date:[unix], open, high, low, close, volume } */
export async function usOhlc(ticker, { days = 400, timeoutMs = 15000 } = {}) {
  const now = Math.floor(Date.now() / 1000), from = now - days * 86400;
  const qs = new URLSearchParams({ aftermarket: '0', chartEventsVersion: '2', dateFrom: String(from), dateTo: String(now + 86400), events: 'false',
    financialAttachments: '', instrument: 'stock', patterns: 'true', premarket: '0', rev: String(Date.now()), ticker, timeframe: 'd' });
  const r = await fetch(`${US_CHART}?${qs}`, { headers: { 'user-agent': UA, accept: 'application/json', referer: `${US_CHART_REF}?t=${encodeURIComponent(ticker)}` },
    signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`미국 차트 HTTP ${r.status}`);
  const j = await r.json();
  return { ...normUs(j), pats: j.patterns || [], pMin: +j.patternsMinRange || null, pMax: +j.patternsMaxRange || null };
}

export const PX = { w: 600, bar: 3, h: 300 };
const LV_V = 3;                                                                  // 2 = 미국 제공처 선 반영, 3 = 주요 지지·저항 추가 (예전 계산분은 다시 받음)
const KIND = { 1: '수평선', 2: '위 추세선', 3: '아래 추세선' };
/** 제공처 선 → [{a:{i,d,p}, b:{i,d,p}, now, slope, kind, name, bounces, strength, status}] (b 는 오늘까지 늘린 값) */
export function patternLines(B) {
  const n = B.c?.length || 0, lo = B.pMin, hi = B.pMax;
  if (!n || !(hi > lo) || !B.pats?.length) return [];
  const toI = x => n - 1 - Math.round((PX.w - x) / PX.bar), toP = y => hi - y * (hi - lo) / PX.h;
  const out = [];
  for (const q of B.pats) {
    const segs = [[q.x1, q.y1, q.x2, q.y2]];
    if (q.kind > 3 && (q.x3 || q.x4)) segs.push([q.x3, q.y3, q.x4, q.y4]);
    for (const [x1, y1, x2, y2] of segs) {
      if (!(x2 > x1)) continue;
      const i1 = Math.max(0, toI(x1)), i2 = Math.min(n - 1, toI(x2)), p1 = toP(y1), p2 = toP(y2);
      if (!(p1 > 0 && p2 > 0) || i2 <= i1) continue;
      const slope = (p2 - p1) / (i2 - i1), now = p1 + slope * (n - 1 - i1);
      out.push({ a: { d: B.d[i1], p: r4(p1) }, b: { d: B.d[n - 1], p: r4(now) }, now: r4(now), slope: r4(slope), kind: q.kind, name: KIND[q.kind] || `패턴 ${q.kind}`,
        bounces: q.bounces ?? 0, strength: q.strength != null ? +(+q.strength).toFixed(1) : null, status: q.status ?? null });
    }
  }
  // 좌표 검증 — 선이 1년 가격 범위에서 크게 벗어나면 변환 규칙이 바뀐 것으로 보고 버린다
  const minL = Math.min(...B.l), maxH = Math.max(...B.h);
  return out.filter(x => x.now > minL * 0.7 && x.now < maxH * 1.4);
}

/** 제공처 선을 지지·저항 목록으로 — 수평선·추세선 모두 '오늘 값' 기준. 선 없으면 계산한 결과 그대로 */
export function mergePatterns(lv, B) {
  const L = patternLines(B);
  if (!lv || !L.length) return lv;
  const px = lv.px, gap = Math.max(0.3 * lv.atr, px * 0.005);
  const it = x => ({ p: x.now, n: Math.max(1, x.bounces), d: x.a.d, src: 'chart', name: x.name, slope: x.slope });
  const sup = L.filter(x => x.now < px - gap).sort((a, b) => b.now - a.now).map(it);
  const res = L.filter(x => x.now > px + gap).sort((a, b) => a.now - b.now).map(it);
  const tlUp = L.filter(x => x.slope > 0 && x.now < px).sort((a, b) => b.now - a.now)[0];
  // 제공처 선이 없는 쪽은 계산한 선으로 채운다 (최대 3개)
  const fill = (a, b, dir) => [...a, ...b.filter(y => !a.some(x => Math.abs(x.p - y.p) <= LV.tol * lv.atr)).map(y => ({ ...y, src: 'calc' }))]
    .sort((x, y) => dir * (x.p - y.p)).slice(0, LV.keep);
  // 주요선 — 제공처 선 중 강도(strength)가 가장 큰 것, 없으면 계산한 주요선
  const big = arr => { const x = [...arr].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))[0]; return x ? { p: x.now, n: Math.max(1, x.bounces), d: x.a.d, src: 'chart', name: x.name } : null; };
  const major = { sup: big(L.filter(x => x.now < px - gap)) || lv.major?.sup || null, res: big(L.filter(x => x.now > px + gap)) || lv.major?.res || null };
  return { ...lv, major, sup: fill(sup, lv.sup || [], -1), res: fill(res, lv.res || [], 1), lines: L, src: 'chart',
    tl: tlUp ? { a: { d: tlUp.a.d, p: tlUp.a.p }, b: { d: tlUp.b.d, p: tlUp.now }, now: tlUp.now, slope: tlUp.slope, touch: tlUp.bounces, broke: false, src: 'chart' } : lv.tl };
}

export function normUs(j) {
  const n = Math.min(j?.date?.length || 0, j?.close?.length || 0);
  if (!n) throw new Error('미국 차트 응답에 봉이 없어');
  const o = { d: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < n; i++) {
    const c = +j.close[i];
    if (!(c > 0)) continue;
    o.d.push(iso(j.date[i])); o.c.push(c);
    o.o.push(+j.open?.[i] || c); o.h.push(Math.max(+j.high?.[i] || c, c)); o.l.push(Math.min(+j.low?.[i] || c, c)); o.v.push(+j.volume?.[i] || 0);
  }
  return o;
}

/** ATR(14) — 단순 평균 */
function atrOf(B, n = 14) {
  const tr = [];
  for (let i = 1; i < B.c.length; i++) tr.push(Math.max(B.h[i] - B.l[i], Math.abs(B.h[i] - B.c[i - 1]), Math.abs(B.l[i] - B.c[i - 1])));
  const t = tr.slice(-n);
  return t.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
}

/** 스윙 고점·저점 (좌우 k봉 확인. 마지막 k봉은 아직 확정 안 돼서 뺀다) */
function pivots(B, k) {
  const hi = [], lo = [], n = B.c.length;
  for (let i = k; i < n - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k && (isH || isL); j++) {
      if (j === i) continue;
      if (B.h[j] > B.h[i]) isH = false;
      if (B.l[j] < B.l[i]) isL = false;
    }
    if (isH) hi.push({ i, p: B.h[i] });
    if (isL) lo.push({ i, p: B.l[i] });
  }
  return { hi, lo };
}

/** 가격이 가까운 고점·저점을 한 선으로 묶음 — 선 가격은 최근 터치에 가중 */
function cluster(pts, tol, n) {
  const s = [...pts].sort((a, b) => a.p - b.p), out = [];
  for (const x of s) {
    const g = out[out.length - 1];
    if (g && x.p - g.max <= tol && x.p - g.min <= 2 * tol) { g.pts.push(x); g.max = x.p; } else out.push({ pts: [x], min: x.p, max: x.p });   // 사슬처럼 길게 이어지지 않게 폭 2·tol 까지
  }
  return out.map(g => {
    let w = 0, a = 0, last = 0;
    for (const x of g.pts) { const k = 0.5 + x.i / n; w += k; a += k * x.p; last = Math.max(last, x.i); }
    return { p: a / w, n: g.pts.length, last, hiN: g.pts.filter(x => x.t === 'h').length, loN: g.pts.filter(x => x.t === 'l').length };
  });
}

/** 상승 추세선 — 스윙 저점 a→b (b가 더 높음), a~끝 사이 저가가 선 − slack·ATR 아래로 안 내려간 가장 긴 선 (끝은 이탈 판정에만 씀) */
function upTrend(B, lows, atr) {
  const n = B.c.length, sl = LV.slack * atr;
  let best = null;
  for (let bi = lows.length - 1; bi >= 1; bi--) {
    const b = lows[bi];
    if (n - 1 - b.i > 120) break;                                               // 너무 오래된 선은 안 씀
    for (let ai = 0; ai < bi; ai++) {
      const a = lows[ai];
      if (b.i - a.i < LV.tlMin || b.p <= a.p) continue;
      const slope = (b.p - a.p) / (b.i - a.i), at = i => a.p + slope * (i - a.i);
      let ok = true;
      for (let i = a.i; i <= b.i && ok; i++) if (B.l[i] < at(i) - sl) ok = false;
      if (!ok) continue;
      const span = b.i - a.i, touch = lows.filter(x => x.i >= a.i && x.i <= b.i && Math.abs(x.p - at(x.i)) <= sl * 2).length;
      if (!best || touch > best.touch || (touch === best.touch && span > best.span)) best = { a, b, slope, span, touch, now: at(n - 1) };
    }
    if (best) break;                                                            // 가장 최근 저점으로 끝나는 선을 우선
  }
  if (!best) return null;
  const brk = B.c[n - 1] < best.now - sl;
  return { a: { d: B.d[best.a.i], p: r4(best.a.p) }, b: { d: B.d[best.b.i], p: r4(best.b.p) }, now: r4(best.now), slope: r4(best.slope), touch: best.touch, broke: brk };
}

/**
 * 지지·저항 계산.
 * @returns { d, px, atr, sup:[{p,n,d}], res:[{p,n,d}], tl, hi52, lo52 }  sup 는 가까운 순(위→아래), res 는 가까운 순(아래→위)
 */
export function levelsOf(B) {
  const n = B.c.length;
  if (n < 60) return null;
  const px = B.c[n - 1], atr = atrOf(B), tol = LV.tol * atr;
  const pv = pivots(B, LV.k);
  const all = [...pv.hi.map(x => ({ ...x, t: 'h' })), ...pv.lo.map(x => ({ ...x, t: 'l' }))];
  const lines = cluster(all, tol, n).map(g => ({ ...g, d: B.d[g.last] }));
  const gap = Math.max(0.3 * atr, px * 0.005);                                // 지금 가격에 딱 붙은 선은 지지·저항으로 안 셈
  const strong = (a, b) => b.n - a.n || b.last - a.last;
  const pick = arr => { const out = []; for (const x of arr) { if (out.length >= LV.keep) break; out.push({ p: r4(x.p), n: x.n, d: x.d }); } return out; };
  const sup = pick(lines.filter(x => x.p < px - gap).sort((a, b) => b.p - a.p));
  const hi52 = Math.max(...B.h.slice(-252)), lo52 = Math.min(...B.l.slice(-252));
  // 최근 k봉 안의 고점은 아직 스윙으로 확정 안 됐지만 바로 위 저항 — 1년 최고가가 위에 있고 묶인 선이 근처에 없으면 추가
  const upL = lines.filter(x => x.p > px + gap);
  const hiI = B.h.lastIndexOf(hi52);
  if (hi52 > px + gap && !upL.some(x => Math.abs(x.p - hi52) <= tol)) upL.push({ p: hi52, n: 1, last: hiI, d: B.d[hiI] });
  const res = pick(upL.sort((a, b) => a.p - b.p));
  // 주요 지지·저항 — 가까운 순이 아니라 터치가 가장 많은(같으면 가까운) 선 하나씩. 멀어도 큰 매물대를 보이려고
  const mj = arr => { const x = [...arr].sort((a, b) => b.n - a.n || Math.abs(a.p - px) - Math.abs(b.p - px))[0]; return x && x.n >= 2 ? { p: r4(x.p), n: x.n, d: x.d } : null; };
  return { d: B.d[n - 1], px: r4(px), atr: r4(atr), sup, res, tl: upTrend(B, pv.lo, atr), hi52: r4(hi52), lo52: r4(lo52),
    major: { sup: mj(lines.filter(x => x.p < px - gap)), res: mj(upL) },
    strongest: lines.sort(strong).slice(0, 1).map(x => r4(x.p))[0] ?? null };
}

/**
 * 눌림매매 손절·목표를 차트 선으로 보정.
 *   손절: 진입가 아래 가장 가까운 지지(수평선·상승 추세선 중 높은 것) − 0.5 ATR. 진입가 −8% 보다 깊으면 −8% (규칙 상한)
 *   1차 목표: 진입가 위 가장 가까운 저항(+2% 이상). 없으면(신고가권) 규칙 목표 그대로
 *   손익비: (목표 − 진입) ÷ max(진입 − 손절, 진입 × 3%)
 * @param e { px, stop, tgt } — 규칙 기준 진입·손절·목표
 */
export function srPlan(e, lv) {
  if (!e?.px || !lv?.atr) return null;
  const px = e.px, pad = LV.pad * lv.atr;
  const cand = [...(lv.sup || []).map(x => ({ p: x.p, k: 'h', n: x.n, name: x.src === 'chart' ? x.name : null })), ...(lv.tl && !lv.tl.broke ? [{ p: lv.tl.now, k: 't', n: lv.tl.touch }] : [])]
    .filter(x => x.p < px * 0.995).sort((a, b) => b.p - a.p);
  const s0 = cand[0] || null, floor = px * (1 - LV.maxLoss / 100);
  let stop = s0 ? s0.p - pad : null, why = s0 ? (s0.k === 't' ? '상승 추세선' : s0.name ? `차트 ${s0.name}` : `지지선(${s0.n}회 터치)`) : null;
  if (stop != null && stop < floor) { stop = floor; why = `${why}이 멀어 −${LV.maxLoss}% 손절`; }
  if (stop == null) { stop = e.stop; why = '지지선 없음 — 규칙 손절'; }
  const r0 = (lv.res || []).find(x => x.p >= px * 1.02) || null;
  const tgt = r0 ? r0.p : e.tgt, twhy = r0 ? (r0.src === 'chart' ? `차트 ${r0.name}` : `저항선(${r0.n}회 터치)`) : '위 저항 없음(신고가권) — 규칙 목표';
  const risk = Math.max(px - stop, px * 0.03), rr = tgt > px ? (tgt - px) / risk : 0;
  return { stop: r4(stop), tgt: r4(tgt), rr: +rr.toFixed(2), why, twhy, sup: s0 ? r4(s0.p) : null, res: r0 ? r4(r0.p) : null };
}

/** 한 종목만 바로 계산·저장 (상세 조회·종목 추가 때). 미국이 차단 대기 중이면 null */
export async function levelsFor(m, code) {
  if (m === 'US' && (await store.get(BLOCK))) return null;
  try {
    const B = m === 'US' ? await usOhlc(code) : await krOhlc(code, 400);
    const lv = m === 'US' ? mergePatterns(levelsOf(B), B) : levelsOf(B);
    const rec = lv ? { ...lv, v: LV_V, at: new Date().toISOString() } : { d: B.d?.[B.d.length - 1] || '', v: LV_V, at: new Date().toISOString(), none: true };
    await store.set(KEY(m, code), rec, 40 * 86400);
    return rec;
  } catch (e) {
    if (m === 'US' && /HTTP (403|429)/.test(e.message)) await store.set(BLOCK, { at: new Date().toISOString(), why: e.message }, 6 * 3600);
    return null;
  }
}
/** 다시 받아야 하나 — 없거나, 미국 예전 형식이거나, 마지막 봉보다 오래됐고 12시간 지남 */
export const lvStale = (m, lv, lastDate) => !lv || (m === 'US' && lv.v !== LV_V) || (lastDate && lv.d < lastDate && Date.now() - Date.parse(lv.at || 0) > 12 * 3600e3);

/** 저장된 선 묶음 읽기 */
export async function loadLevels(m, codes) {
  if (!codes.length) return {};
  const out = {};
  for (let i = 0; i < codes.length; i += 50) {
    const part = codes.slice(i, i + 50), got = await store.mget(part.map(c => KEY(m, c)));
    got.forEach((v, k) => { if (v) out[part[k]] = v; });
  }
  return out;
}

/** 수집 대상 — 눌림목 후보(최근 20일 진입) + 내 목록 */
export async function levelTargets(m) {
  const [daily, mine] = await Promise.all([store.get(`univ:daily:${m}`), store.listAll()]);
  const s = new Set((daily?.pbs || []).map(x => x.code));
  for (const it of mine) if (it?.m === m) s.add(it.code);
  return { codes: [...s], asof: daily?.asof || null };
}

/**
 * 하루 한 번 — 오늘 기준 선이 없는 종목만 받아서 계산·저장. 요청 사이 1.5초(미국), 403·429 면 6시간 쉼.
 * @returns { done, got, left, failed }
 */
export async function collectLevels(m, budgetMs = 40000) {
  const t0 = Date.now();
  if (m === 'US' && (await store.get(BLOCK))) return { done: true, got: 0, left: 0, blocked: true };
  const { codes, asof } = await levelTargets(m);
  const have = await loadLevels(m, codes);
  const need = codes.filter(c => lvStale(m, have[c], asof));
  let got = 0, failed = 0, i = 0;
  for (; i < need.length; i++) {
    if (Date.now() - t0 > budgetMs) break;
    const c = need[i];
    try {
      const B = m === 'US' ? await usOhlc(c) : await krOhlc(c, 400);
      const lv = m === 'US' ? mergePatterns(levelsOf(B), B) : levelsOf(B);   // 미국은 제공처가 그린 선 우선
      await store.set(KEY(m, c), lv ? { ...lv, v: LV_V, at: new Date().toISOString() } : { d: asof || '', v: LV_V, at: new Date().toISOString(), none: true }, 40 * 86400);
      got++;
    } catch (e) {
      failed++;
      if (m === 'US' && /HTTP (403|429)/.test(e.message)) { await store.set(BLOCK, { at: new Date().toISOString(), why: e.message }, 6 * 3600); i++; break; }
      await store.set(KEY(m, c), { d: asof || '', v: LV_V, at: new Date().toISOString(), none: true, err: e.message.slice(0, 80) }, 86400);   // 실패도 하루는 다시 안 감
    }
    if (m === 'US') await sleep(1500);
  }
  const left = need.length - i;
  return { done: left <= 0, got, failed, left, total: codes.length };
}
