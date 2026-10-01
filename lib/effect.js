// 국면 효과 — 'N일 후 수익률' 대신 국면이 실제로 하는 일(얼마나 오래, 얼마나 빨리, 위아래 어느 쪽으로)을 보여준다.
//   구간마다: hold(진입일→전환 확인일 거래일 수), mo(월 환산 = 20거래일 복리 속도, 10일 미만은 null),
//            ex(같은 기간 지수 대비 %p), next(다음 국면)
//   계절별: 월 환산은 그 계절에 머문 모든 날을 이어 붙인 복리 속도(짧은 구간이 숫자를 튀게 하지 않음)
//   따라 했다면(기간: 연초·3개월·6개월·1년·2년·3년·5년): 봄·여름만 보유 / 단계 매매(봄 진입 50% → 여름 +50% → 가을 보유분의 80% 매도 → 겨울 전량) / 계속 보유
import { SEASONS } from './engine.js';

const MO = 20, MIN_MO = 10, WARMUP = 60, COST = 0.001;     // 한 달 = 20거래일, 거래비용 회전율 1당 0.1%
export const STAGE = { spring: 0.5, add: 0.5, sell: 0.8 };   // 단계 매매 규칙 — 가을엔 보유분의 sell 만큼 매도

const moOf = (r, hold) => (hold >= MIN_MO && r > -100 ? +((Math.pow(1 + r / 100, MO / hold) - 1) * 100).toFixed(2) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
const r2 = x => (x == null || !isFinite(x) ? null : +x.toFixed(2));

/** 계절별 연속 구간 [시즌번호, 시작, 끝] */
function runsOf(season, n) {
  const runs = []; let a = 0;
  for (let t = 1; t <= n; t++) if (t === n || season[t] !== season[a]) { runs.push([season[a], a, t - 1]); a = t; }
  return runs;
}

/** 계절 하나에 머문 날들을 이어 붙인 결과 — eps: [{r(%), hold, mx, mdd, next}] */
function pool(eps) {
  const done = eps.filter(e => !e.ongoing);
  let lr = 0, days = 0; for (const e of done) { lr += Math.log(1 + e.rEnd / 100); days += e.hold; }
  const next = {}; for (const e of done) if (e.next) next[e.next] = (next[e.next] || 0) + 1;
  return {
    n: eps.length, done: done.length,
    days: done.length ? Math.round(done.reduce((a, e) => a + e.days, 0) / done.length) : null,
    med: r2(med(done.map(e => e.rEnd))),
    mo: days ? r2((Math.exp(lr * MO / days) - 1) * 100) : null,
    up: done.length ? Math.round(100 * done.filter(e => e.rEnd > 0).length / done.length) : null,
    mx: done.length ? r2(done.reduce((a, e) => a + e.mx, 0) / done.length) : null,
    mdd: done.length ? r2(done.reduce((a, e) => a + e.mdd, 0) / done.length) : null,
    next,
  };
}

/** 일별 시뮬레이션 — weightAt(t, w) 가 그날 종가에 정한 다음 날 비중 */
function sim(P, t0, n, step) {
  let E = 1, pk = 1, mdd = 0, w = 0, wsum = 0, trades = 0;
  for (let t = t0; t < n; t++) {
    if (t > t0) { E *= 1 + w * (P[t] / P[t - 1] - 1); pk = Math.max(pk, E); mdd = Math.min(mdd, E / pk - 1); wsum += w; }
    const nw = step(t, w);
    if (nw !== w) { E *= 1 - COST * Math.abs(nw - w); trades++; w = nw; }
  }
  const days = n - 1 - t0;
  return { cum: r2((E - 1) * 100), mdd: r2(mdd * 100), expo: days > 0 ? Math.round(100 * wsum / days) : 0, trades };
}

/**
 * 종목 하나의 국면 효과.
 * A = analyze 결과 {s, season}, history = historyOf 결과(최신순), ix = 지수 Series 또는 null, keep = 표시 창
 */
export function effectOf(A, history, ix, keep = 1265) {
  const { s, season } = A, n = s.p.length, P = s.p, t0 = Math.max(WARMUP, n - keep);
  const runs = runsOf(season, n), byStart = new Map(runs.map((r, i) => [s.d[r[1]], i]));
  // 구간별 보강
  for (const h of history) {
    const i = byStart.get(h.a); if (i == null) continue;
    const [, a, b] = runs[i], exit = h.ongoing ? n - 1 : b + 1;
    h.hold = Math.max(1, exit - a);
    h.mo = h.ongoing ? null : moOf(h.rEnd, h.hold);
    h.next = i + 1 < runs.length ? SEASONS[runs[i + 1][0]] : null;
    if (ix) {
      const i0 = ix.at(h.a), i1 = ix.at(h.x);
      h.ex = i0 >= 0 && i1 >= 0 ? r2(h.rEnd - (ix.p[i1] / ix.p[i0] - 1) * 100) : null;
    }
  }
  // 계절별
  const seasons = Object.fromEntries(SEASONS.map(nm => [nm, pool(history.filter(h => h.s === nm))]));
  // 따라 했다면 — 기간별(연초·3개월~5년). 창 시작일의 계절에 맞춘 비중에서 출발
  const S = t => season[t];
  const init = { 0: STAGE.spring, 1: STAGE.spring + STAGE.add, 2: (STAGE.spring + STAGE.add) * (1 - STAGE.sell), 3: 0 };
  const followFrom = t0 => {
    const ss = sim(P, t0, n, t => (S(t) <= 1 ? 1 : 0));
    const staged = sim(P, t0, n, (t, w) => {
      if (t === t0) return init[S(t)];
      if (S(t) === S(t - 1)) return w;
      switch (S(t)) {
        case 0: return w > 0 ? w : STAGE.spring;
        case 1: return Math.min(1, +(w + STAGE.add).toFixed(4));
        case 2: return +(w * (1 - STAGE.sell)).toFixed(4);
        default: return 0;
      }
    });
    const hold = sim(P, t0, n, () => 1);
    // 겨울 동안 계속 들고 있었다면 (겨울 판정일 종가 → 다음 날들)
    let lw = 0, wd = 0; for (let t = t0 + 1; t < n; t++) if (S(t - 1) === 3) { lw += Math.log(P[t] / P[t - 1]); wd++; }
    const wDone = history.filter(h => h.s === '겨울' && !h.ongoing && h.a >= s.d[t0]);
    const winter = { r: wd ? r2((Math.exp(lw) - 1) * 100) : null, days: wd, n: wDone.length, down: wDone.filter(h => h.rEnd < 0).length };
    return { ss, staged, hold, winter, from: s.d[t0], to: s.d[n - 1], days: n - 1 - t0 };
  };
  const base = Math.max(WARMUP, n - keep), at = N => Math.max(base, n - 1 - N);
  const y0 = s.d[n - 1].slice(0, 4) + '-01-01'; let ty = n - 1; while (ty > base && s.d[ty] >= y0) ty--;
  const PER = [['YTD', '연초', ty], ['3M', '3개월', at(63)], ['6M', '6개월', at(126)], ['1Y', '1년', at(252)], ['2Y', '2년', at(504)], ['3Y', '3년', at(756)], ['5Y', '5년', base]];
  const follows = {}; for (const [k, , t0] of PER) if (t0 < n - 1) follows[k] = followFrom(t0);
  const meta = { stage: STAGE, cost: COST * 100, periods: PER.filter(([k]) => follows[k]).map(([k, t]) => [k, t]) };
  return { seasons, follow: { ...follows['5Y'], ...meta }, follows, ...meta };
}

/** 유니버스 전체 — 같은 계절의 기준선 (전략실 단계에서 하루 한 번). items: prepItem 결과 */
export function universeEffect(items, keep = 1265) {
  const acc = SEASONS.map(() => ({ lr: 0, days: 0, n: 0, up: 0, len: [], next: {} }));
  let used = 0;
  for (const x of items) {
    const P = x.s.p, n = P.length, season = x.season, from = Math.max(WARMUP, n - keep);
    const runs = runsOf(season, n); let any = false;
    for (let i = 0; i < runs.length - 1; i++) {        // 끝난 구간만
      const [si, a, b] = runs[i]; if (a < from) continue;
      const exit = b + 1, r = P[exit] / P[a];
      if (!(r > 0) || !isFinite(r)) continue;
      const c = acc[si]; c.lr += Math.log(r); c.days += exit - a; c.n++; if (r > 1) c.up++; c.len.push(b - a + 1);
      const nx = SEASONS[runs[i + 1][0]]; c.next[nx] = (c.next[nx] || 0) + 1; any = true;
    }
    if (any) used++;
  }
  const seasons = Object.fromEntries(SEASONS.map((nm, k) => {
    const c = acc[k];
    return [nm, { n: c.n, mo: c.days ? r2((Math.exp(c.lr * MO / c.days) - 1) * 100) : null, up: c.n ? Math.round(100 * c.up / c.n) : null,
      days: c.len.length ? Math.round(med(c.len)) : null, next: c.next }];
  }));
  return { n: used, seasons };
}
