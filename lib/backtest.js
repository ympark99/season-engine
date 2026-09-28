// 국면 신뢰도 측정 — "국면이 맞았나"를 절대 수익률이 아니라 같은 날 유니버스 평균(BM) 대비 초과수익으로 잴다.
// 강세장에서는 死 종목도 오르기 때문에 절대 수익률로는 국면이 쓸모없어 보인다. 양형모 코멘트가 늘 BM 대비로 말하는 이유이기도 하다.
//   daily : 매일 그 국면에 있던 모든 종목·모든 날의 선행수익률 (국면을 '보유 신호'로 볼 때)
//   entry : 국면이 바뀜 날만 (국면을 '매매 신호'로 볼 때)
//   prob  : 확률 구간별 — 확률이 높을수록 초과수익이 커지면 Ps 가 정보를 담고 있다는 뜻
import { Series, classify, features, psOf, SEASONS } from './engine.js';

export const HORIZONS = [5, 20, 60];
const WARMUP = 60;

/** 종목별 Series·국면·확률 준비 (파라미터가 바뀌면 국면만 다시 계산) */
export function prep(barsByCode, minBars = 300) {
  const out = [];
  for (const [code, b] of Object.entries(barsByCode)) {
    if (!b?.d?.length || b.d.length < minBars) continue;
    out.push({ code, s: new Series(b.d, b.c, b.v) });
  }
  return out;
}

/** 날짜 문자열 → 정수 인덱스 (시장 전체 공통 축) */
function dateAxis(items) {
  const set = new Set();
  for (const it of items) for (const d of it.s.d) set.add(d);
  const dates = [...set].sort(), idx = new Map(dates.map((d, i) => [d, i]));
  return { dates, idx };
}

const emptyCell = () => ({ n: 0, raw: 0, exc: 0, hit: 0 });
const finish = c => ({ n: c.n, raw: c.n ? +(100 * c.raw / c.n).toFixed(2) : null, exc: c.n ? +(100 * c.exc / c.n).toFixed(2) : null,
  hit: c.n ? Math.round(100 * c.hit / c.n) : null });

/**
 * @param items  prep() 결과
 * @param P      규칙 파라미터
 * @param opts   {horizons, from, to, cal(확률 구간용), probBuckets}
 * 반환: {daily, entry, prob, dist, nSym, span, obs}
 */
export function evaluate(items, P, { horizons = HORIZONS, from = null, to = null, cal = null } = {}) {
  const { dates, idx } = dateAxis(items), D = dates.length;
  const seasons = items.map(it => classify(it.s, P));
  const inWin = d => (!from || d >= from) && (!to || d <= to);

  // 1) 날짜별 시장 평균(BM) 선행수익률
  const mkt = horizons.map(() => ({ sum: new Float64Array(D), cnt: new Int32Array(D) }));
  for (let k = 0; k < items.length; k++) {
    const { s } = items[k], n = s.p.length;
    for (let h = 0; h < horizons.length; h++) {
      const H = horizons[h], M = mkt[h];
      for (let t = WARMUP; t + H < n; t++) {
        if (!inWin(s.d[t])) continue;
        const j = idx.get(s.d[t]), r = s.p[t + H] / s.p[t] - 1;
        M.sum[j] += r; M.cnt[j]++;
      }
    }
  }
  const mean = mkt.map(M => Float64Array.from(M.sum, (v, j) => (M.cnt[j] > 4 ? v / M.cnt[j] : NaN)));

  // 2) 국면별 집계
  const mk = () => SEASONS.map(() => horizons.map(emptyCell));
  const daily = mk(), entry = mk(), dist = SEASONS.map(() => 0);
  const PB = [[0, 40], [40, 60], [60, 80], [80, 101]];
  const PS = ['여름', '겨울'];                       // 확률 구간은 국면 안에서 봐야 의미가 있음 (旺 90% vs 旺 40%)
  const prob = PS.map(() => PB.map(() => horizons.map(emptyCell)));
  let obs = 0;

  for (let k = 0; k < items.length; k++) {
    const { s } = items[k], season = seasons[k], n = s.p.length;
    const ps = cal ? (() => { const { F } = features(s, season); return Array.from(season, (x, t) => psOf(x, F[t], cal)); })() : null;
    for (let t = WARMUP; t < n; t++) {
      if (!inWin(s.d[t])) continue;
      dist[season[t]]++;
      const isEntry = t > 0 && season[t] !== season[t - 1];
      for (let h = 0; h < horizons.length; h++) {
        const H = horizons[h];
        if (t + H >= n) continue;
        const j = idx.get(s.d[t]), mu = mean[h][j];
        if (!isFinite(mu)) continue;
        const r = s.p[t + H] / s.p[t] - 1, e = r - mu;
        const add = c => { c.n++; c.raw += r; c.exc += e; if (e > 0) c.hit++; };
        add(daily[season[t]][h]); obs++;
        if (isEntry) add(entry[season[t]][h]);
        if (ps) { const q = PS.indexOf(SEASONS[season[t]]); if (q >= 0) { const c2 = PB.findIndex(([a, z]) => ps[t] >= a && ps[t] < z); if (c2 >= 0) add(prob[q][c2][h]); } }
      }
    }
  }
  const pack = arr => Object.fromEntries(SEASONS.map((s, i) => [s, Object.fromEntries(horizons.map((H, h) => [H, finish(arr[i][h])]))]));
  const dtot = dist.reduce((a, x) => a + x, 0) || 1;
  return {
    horizons, nSym: items.length, span: { a: dates[0], b: dates[D - 1], from, to }, obs,
    daily: pack(daily), entry: pack(entry),
    prob: Object.fromEntries(PS.map((s2, q) => [s2, PB.map(([a, z], i) => ({ range: `${a}~${z - 1}%`, h: Object.fromEntries(horizons.map((H, h) => [H, finish(prob[q][i][h])])) }))])),
    dist: Object.fromEntries(SEASONS.map((s, i) => [s, +(100 * dist[i] / dtot).toFixed(1)])),
  };
}

/** 엔진이 쓸모 있으려면 旺(여름)이 BM 을 이기고 死(겨울)가 BM 에 져야 한다. 그 간격이 점수.
 *  표본이 적은 국면은 평균이 튀므로 n/(n+shrink) 로 줄여서 더함 (쏠린 해가 이기지 못하게). */
export function spreadOf(ev, H = 20, shrink = 1000) {
  const v = s => { const c = ev.daily[s]?.[H]; return c?.n ? c.exc * (c.n / (c.n + shrink)) : 0; };
  return +((v('여름') + v('봄') * 0.5) - (v('겨울') + v('가을') * 0.5)).toFixed(3);
}

/** DS 가 코멘트에서 공개한 유니버스 분포 (S&P 500, 2026-09-22 기준). 우리 판정이 이 비율에서 멀면 임계값이 틀린 것. */
export const DS_DIST = { 봄: 29.8, 여름: 33.8, 가을: 11.8, 겨울: 24.6 };

/** 각 종목의 마지막 날 국면 분포 — 오늘 기준 비율 (DS 공개 분포와 비교용) */
export function snapshotDist(items, P) {
  const cnt = SEASONS.map(() => 0);
  for (const it of items) { const sea = classify(it.s, P); cnt[sea[sea.length - 1]]++; }
  const n = items.length || 1;
  return Object.fromEntries(SEASONS.map((s, i) => [s, +(100 * cnt[i] / n).toFixed(1)]));
}
export const distGap = (d, target = DS_DIST) => +SEASONS.reduce((a, s) => a + Math.abs((d[s] ?? 0) - target[s]), 0).toFixed(1);

/** 튜닝 목적함수 — 예측력(초과수익 간격) + DS 분포 근접 + DS 라벨 재현. 한 국면이 3% 미만으로 쏠리면 탈락 */
export function objective(ev, { dist = null, target = null, dsAcc = null, wDist = 0.06, wDs = 5 } = {}) {
  if (Math.min(...SEASONS.map(s => ev.dist[s] ?? 0)) < 3) return { score: -99, why: '한 국면이 3% 미만 — 쏠린 판정' };
  const sp = spreadOf(ev);
  const gap = dist && target ? distGap(dist, target) : null;
  const score = sp - (gap == null ? 0 : wDist * gap) + (dsAcc == null ? 0 : wDs * dsAcc);
  return { score: +score.toFixed(3), spread: sp, gap, dsAcc };
}

/* ---------------- 나눠서 돌리기 (하루치를 여러 번에 걸쳐) ----------------
   전종목을 한 번에 계산하면 함수 시간 제한에 걸리므로 두 패스로 쪼개다.
   1) mkt  : 날짜별 시장 평균(BM) 선행수익률을 종목 묶음 단위로 누적
   2) stat : 그 평균을 기준으로 국면별 초과수익을 종목 묶음 단위로 누적
   누적값은 Redis 에 두고, 마지막에 finalizeCells 로 표를 만든다. */

/** 1패스 — acc[date] = [s5,n5, s20,n20, s60,n60] */
export function mktChunk(items, horizons, acc) {
  for (const { s } of items) {
    const n = s.p.length;
    for (let h = 0; h < horizons.length; h++) {
      const H = horizons[h];
      for (let t = WARMUP; t + H < n; t++) {
        const d = s.d[t], r = s.p[t + H] / s.p[t] - 1;
        const a = acc[d] || (acc[d] = new Array(horizons.length * 2).fill(0));
        a[h * 2] += r; a[h * 2 + 1]++;
      }
    }
  }
  return acc;
}

export const newCells = (horizons = HORIZONS) => ({
  horizons, obs: 0, nSym: 0, dist: [0, 0, 0, 0], snap: [0, 0, 0, 0], span: { a: null, b: null },
  daily: SEASONS.map(() => horizons.map(() => [0, 0, 0, 0])),      // [n, rawSum, excSum, hit]
  entry: SEASONS.map(() => horizons.map(() => [0, 0, 0, 0])),
  prob: [0, 1].map(() => [0, 1, 2, 3].map(() => horizons.map(() => [0, 0, 0, 0]))),
});
const PB = [[0, 40], [40, 60], [60, 80], [80, 101]], PS_IDX = { 여름: 0, 겨울: 1 };

/** 2패스 — means[date] = [m5, m20, m60] (1패스 결과에서 계산) */
export function statChunk(items, P, cal, means, cells, { from = null, to = null } = {}) {
  const horizons = cells.horizons;
  for (const { s } of items) {
    const season = classify(s, P), n = s.p.length;
    const { F } = features(s, season);
    cells.nSym++;
    cells.snap[season[n - 1]]++;
    if (!cells.span.a || s.d[0] < cells.span.a) cells.span.a = s.d[0];
    if (!cells.span.b || s.d[n - 1] > cells.span.b) cells.span.b = s.d[n - 1];
    for (let t = WARMUP; t < n; t++) {
      const d = s.d[t];
      if ((from && d < from) || (to && d > to)) continue;
      cells.dist[season[t]]++;
      const isEntry = t > 0 && season[t] !== season[t - 1];
      const mu = means[d];
      if (!mu) continue;
      const q = PS_IDX[SEASONS[season[t]]], ps = q != null && cal ? psOf(season[t], F[t], cal) : null;
      const bkt = ps == null ? -1 : PB.findIndex(([a, z]) => ps >= a && ps < z);
      for (let h = 0; h < horizons.length; h++) {
        const H = horizons[h];
        if (t + H >= n || !isFinite(mu[h])) continue;
        const r = s.p[t + H] / s.p[t] - 1, e = r - mu[h];
        const add = c => { c[0]++; c[1] += r; c[2] += e; if (e > 0) c[3]++; };
        add(cells.daily[season[t]][h]); cells.obs++;
        if (isEntry) add(cells.entry[season[t]][h]);
        if (q != null && bkt >= 0) add(cells.prob[q][bkt][h]);
      }
    }
  }
  return cells;
}

/** 1패스 누적값 → 날짜별 평균 (표본 5개 미만인 날은 제외) */
export function meansOf(acc, horizons = HORIZONS) {
  const out = {};
  for (const [d, a] of Object.entries(acc)) {
    const row = horizons.map((_, h) => (a[h * 2 + 1] > 4 ? a[h * 2] / a[h * 2 + 1] : NaN));
    if (row.some(x => isFinite(x))) out[d] = row;
  }
  return out;
}

/** 누적 셀 → evaluate() 와 같은 모양의 표 */
export function finalizeCells(cells) {
  const H = cells.horizons;
  const fin = c => ({ n: c[0], raw: c[0] ? +(100 * c[1] / c[0]).toFixed(2) : null, exc: c[0] ? +(100 * c[2] / c[0]).toFixed(2) : null, hit: c[0] ? Math.round(100 * c[3] / c[0]) : null });
  const pack = arr => Object.fromEntries(SEASONS.map((s, i) => [s, Object.fromEntries(H.map((h, j) => [h, fin(arr[i][j])]))]));
  const dtot = cells.dist.reduce((a, x) => a + x, 0) || 1, stot = cells.snap.reduce((a, x) => a + x, 0) || 1;
  return {
    horizons: H, nSym: cells.nSym, obs: cells.obs, span: cells.span,
    daily: pack(cells.daily), entry: pack(cells.entry),
    prob: Object.fromEntries(['여름', '겨울'].map((s, q) => [s, PB.map(([a, z], i) => ({ range: `${a}~${z - 1}%`, h: Object.fromEntries(H.map((h, j) => [h, fin(cells.prob[q][i][j])])) }))])),
    dist: Object.fromEntries(SEASONS.map((s, i) => [s, +(100 * cells.dist[i] / dtot).toFixed(1)])),
    snapshot: Object.fromEntries(SEASONS.map((s, i) => [s, +(100 * cells.snap[i] / stot).toFixed(1)])),
  };
}
