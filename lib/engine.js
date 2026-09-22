// 생왕쇠사 엔진 — 규칙 상태기계(국면 판정) + 국면 확률 Ps + 임계값 학습.
// 국면 코드: 0=봄(生) 1=여름(旺) 2=가을(衰) 3=겨울(死)
// DS 리포트는 구조와 파라미터 "이름"만 공개. 값은 labels.json(리포트·스크린샷 속 DS 판정)을 재현하도록 학습.

export const SEASONS = ['봄', '여름', '가을', '겨울'];
export const S_IDX = { 봄: 0, 여름: 1, 가을: 2, 겨울: 3 };
export const DEFAULT_PARAMS = { W: 20, b: 0.03, u: 0.15, d1: 0.08, d2: 0.18, TF: 20, TC: 10, vr: 1.2 };
export const DEFAULT_CAL = Object.fromEntries(SEASONS.map(s => [s, { a: 0, b: 1.2, how: '기본값' }])); // 옛 형식 호환
const T_DWELL = [40, 120, 20, 60];
const WARMUP = 60;

export function sma(x, k) {
  const o = new Float64Array(x.length); let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= k) s -= x[i - k]; o[i] = s / Math.min(i + 1, k); }
  return o;
}

/** 한 종목 시계열 + 파라미터와 무관한 캐시 */
export class Series {
  constructor(d, c, v) {
    this.d = d; this.p = Float64Array.from(c); this.v = Float64Array.from(v || c.map(() => 0));
    this.m5 = sma(this.p, 5); this.m20 = sma(this.p, 20); this.m60 = sma(this.p, 60);
    this._hw = new Map(); this._vr = null;
  }
  /** 직전 W봉 최고가 (t 미포함) */
  hw(W) {
    if (this._hw.has(W)) return this._hw.get(W);
    const n = this.p.length, o = new Float64Array(n), dq = [];
    for (let t = 0; t < n; t++) {
      while (dq.length && dq[0] < t - W) dq.shift();
      o[t] = dq.length ? this.p[dq[0]] : 0;
      while (dq.length && this.p[dq[dq.length - 1]] <= this.p[t]) dq.pop();
      dq.push(t);
    }
    this._hw.set(W, o); return o;
  }
  /** 당일 거래량 / 직전 20일 평균 (거래량 없으면 Infinity = 통과) */
  volRatio() {
    if (this._vr) return this._vr;
    const n = this.v.length, o = new Float64Array(n); let s = 0;
    for (let t = 0; t < n; t++) {
      o[t] = t >= 20 && s > 0 && this.v[t] > 0 ? this.v[t] / (s / 20) : Infinity;
      s += this.v[t]; if (t >= 20) s -= this.v[t - 20];
    }
    return (this._vr = o);
  }
  at(date) { // date 이하 가장 가까운 거래일 인덱스
    let lo = 0, hi = this.d.length - 1, a = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.d[m] <= date) { a = m; lo = m + 1; } else hi = m - 1; }
    return a;
  }
}

/** 규칙 상태기계. 신호일 종가까지의 정보만 사용 */
export function classify(s, P) {
  const { p, m5, m20, m60 } = s, n = p.length, hw = s.hw(P.W | 0), vr = s.volRatio();
  const out = new Int8Array(n).fill(3);
  let st = 3, bp = 0, pk = 0, t0 = 0, cool = -1e9;
  for (let t = 0; t < n; t++) {
    if (t < WARMUP) { out[t] = st; continue; }
    const x = p[t];
    if (st === 3) {
      if (t - cool >= P.TC && x >= hw[t] * (1 + P.b) && vr[t] >= P.vr) { st = 0; bp = hw[t]; pk = x; }
    } else if (st === 0) {
      if (x > pk) pk = x;
      if (x >= bp * (1 + P.u) && m5[t] > m20[t] && m20[t] > m60[t]) st = 1;
      else if (x <= bp * (1 - P.d1)) { st = 3; cool = t; }
    } else if (st === 1) {
      if (x > pk) pk = x; else if (x <= pk * (1 - P.d1)) { st = 2; t0 = t; }
    } else {
      if (x > pk) { st = 1; pk = x; }
      else if (x <= pk * (1 - P.d2) || t - t0 > P.TF) { st = 3; cool = t; }
    }
    out[t] = st;
  }
  return out;
}

/* 국면별 설명변수 g_s(f) — 기존 z 식의 항들. logit(Ps) = θ0 + Σ θ_i·g_i */
export const GTERMS = {
  1: { names: ['정배열 f1', '20일선 기울기 f2', '정점 대비 낙폭 f3', '52주 고점 거리 f4'], g: f => [f[0], f[1], f[2], f[3]], w: [1, 0.5, 0.6, 0.8], c: 0 },
  3: { names: ['정배열 f1', '20일선 기울기 f2', '52주 고점 거리 f4', '체류 min(f5,2)'], g: f => [f[0], f[1], f[3], Math.min(f[4], 2)], w: [-1, -0.5, -0.8, 0.3], c: 0 },
  2: { names: ['|f3+1.5| (낙폭 중심 이탈)', '체류 초과 max(0,f5−1)'], g: f => [Math.abs(f[2] + 1.5), Math.max(0, f[4] - 1)], w: [-1, -0.8], c: 1.5 },
  0: { names: ['정배열 f1', '20일선 기울기 f2', '체류 초과 max(0,f5−1)'], g: f => [f[0], f[1], Math.max(0, f[4] - 1)], w: [0.8, 0.5, -0.6], c: 0.5 },
};
export function zscore(s, f) { const T = GTERMS[s], g = T.g(f); return T.c + g.reduce((a, x, i) => a + x * T.w[i], 0); }
/** 사전 θ: 기존 식(z) × b(1.2), 절편 a(0) — 앵커가 적으면 이 값에 가깝게 남음 */
export function priorTheta(s, a = 0, b = 1.2) { const T = GTERMS[s]; return [a + b * T.c, ...T.w.map(w => b * w)]; }

/** 피처 f1~f5 와 국면다움 z */
export function features(s, season) {
  const { p } = s, n = p.length, F = new Array(n), z = new Float64Array(n);
  let rs = 0, pk = p[0];
  const dq = []; // 252일 최고가
  for (let t = 0; t < n; t++) {
    if (t > 0 && season[t] !== season[t - 1]) { rs = t; pk = p[t]; } else pk = Math.max(pk, p[t]);
    while (dq.length && dq[0] < t - 251) dq.shift();
    while (dq.length && p[dq[dq.length - 1]] <= p[t]) dq.pop();
    dq.push(t);
    const h = p[dq[0]];
    const f1 = (Math.sign(s.m5[t] - s.m20[t]) + Math.sign(s.m20[t] - s.m60[t])) / 2;
    const f2 = Math.max(-3, Math.min(3, (s.m20[t] / s.m20[Math.max(0, t - 10)] - 1) / 0.05));
    const f3 = (p[t] / pk - 1) / 0.08;
    const f4 = (p[t] / h - 1) / 0.20;
    const f5 = (t - rs + 1) / T_DWELL[season[t]];
    F[t] = [f1, f2, f3, f4, f5]; z[t] = zscore(season[t], F[t]);
  }
  return { F, z };
}

/** cal[s] = {theta:[θ0, θ1..], how, n}. 옛 형식 {a,b} 도 읽음 */
export function thetaOf(cal, s) {
  const c = cal?.[SEASONS[s]];
  if (c?.theta) return c.theta;
  return priorTheta(s, c?.a ?? 0, c?.b ?? 1.2);
}
export const logitOf = (season, f, cal) => { const th = thetaOf(cal, season), g = GTERMS[season].g(f); return th[0] + g.reduce((a, x, i) => a + x * th[i + 1], 0); };
export const psOf = (season, f, cal) => 100 / (1 + Math.exp(-logitOf(season, f, cal)));

function solve(A, y) { // 작은 선형계 가우스 소거
  const n = y.length, M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** 앵커 [{season, f, target, ok}] → 국면별 θ. 기존 식을 사전값으로 한 ridge 회귀 (λ=2).
 *  앵커 1개면 절편만 이동, 0개면 사전값 그대로. */
export function calibrate(anchors, lambda = 2) {
  const cal = {};
  const logit = q => { const x = Math.min(99, Math.max(1, q)) / 100; return Math.log(x / (1 - x)); };
  for (let s = 0; s < 4; s++) {
    const pts = anchors.filter(a => a.ok && S_IDX[a.season] === s && a.f);
    const prior = priorTheta(s), X = pts.map(a => [1, ...GTERMS[s].g(a.f)]), y = pts.map(a => logit(a.target));
    let theta = prior, how = '기본 식 (앵커 없음)';
    if (pts.length === 1) { const r = y[0] - X[0].reduce((a, x, i) => a + x * prior[i], 0); theta = [prior[0] + r, ...prior.slice(1)]; how = '앵커 1개 — 절편만 이동'; }
    else if (pts.length >= 2) {
      const k = prior.length, A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? lambda : 0))), v = prior.map(p => lambda * p);
      for (let r = 0; r < X.length; r++) for (let i = 0; i < k; i++) { v[i] += X[r][i] * y[r]; for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j]; }
      theta = solve(A, v); how = `앵커 ${pts.length}개 — 기존 식 기준 ridge 회귀`;
    }
    const fitted = pts.map((a, r) => 100 / (1 + Math.exp(-X[r].reduce((q, x, i) => q + x * theta[i], 0))));
    const mae = pts.length ? pts.reduce((q, a, r) => q + Math.abs(fitted[r] - a.target), 0) / pts.length : null;
    cal[SEASONS[s]] = { theta: theta.map(x => +x.toFixed(4)), how, n: pts.length, mae: mae == null ? null : +mae.toFixed(1), terms: GTERMS[s].names };
  }
  return cal;
}
export const DEFAULT_CAL_V2 = calibrate([]);

function runsOf(season) {
  const out = []; let a = 0;
  for (let t = 1; t <= season.length; t++) if (t === season.length || season[t] !== season[a]) { out.push([season[a], a, t - 1]); a = t; }
  return out;
}

/** 목록·상세용 분석 결과. keep = 반환할 최근 봉 수 */
export function analyze(bars, P, cal, keep = 1265) {
  const s = new Series(bars.d, bars.c, bars.v);
  const season = classify(s, P), { F, z } = features(s, season), n = s.p.length;
  const ps = Array.from(season, (x, t) => psOf(x, F[t], cal));
  const runs = runsOf(season), cur = runs[runs.length - 1], prev = runs[runs.length - 2] || cur;
  let hi = 0; for (let t = Math.max(0, n - 252); t < n; t++) hi = Math.max(hi, s.p[t]);
  let segPk = 0; for (let t = cur[1]; t < n; t++) segPk = Math.max(segPk, s.p[t]);
  const events = [];
  for (let i = 1; i < runs.length; i++) if (runs[i][1] >= n - 20) events.push({ d: s.d[runs[i][1]], from: SEASONS[runs[i - 1][0]], to: SEASONS[runs[i][0]] });
  const S = SEASONS[cur[0]];
  const summary = {
    last: s.p[n - 1], lastDate: s.d[n - 1], firstDate: s.d[Math.max(0, n - keep)], bars: Math.min(n, keep),
    season: S, prob: Math.round(ps[n - 1]), psRaw: +ps[n - 1].toFixed(2), z: +z[n - 1].toFixed(3),
    logit: +logitOf(cur[0], F[n - 1], cal).toFixed(3),
    // 5거래일 전 대비 확률 변화 — 같은 국면 안에서만 의미 (국면이 바뀌었으면 null)
    ps5: n > 5 && season[n - 6] === cur[0] ? +(ps[n - 1] - ps[n - 6]).toFixed(1) : null,
    signal: signalOf(cur[0], ps[n - 1], n > 5 && season[n - 6] === cur[0] ? ps[n - 1] - ps[n - 6] : null),
    entry: s.d[cur[1]], age: n - cur[1],
    prev: { s: SEASONS[prev[0]], a: s.d[prev[1]], b: s.d[prev[2]] },
    dd: +((s.p[n - 1] / hi - 1) * 100).toFixed(2), fromPeak: +((s.p[n - 1] / segPk - 1) * 100).toFixed(2),
    sinceEntry: +((s.p[n - 1] / s.p[cur[1]] - 1) * 100).toFixed(2), align: F[n - 1][0],
    ribbon: Array.from(season.slice(-120)).join(''), spark: Array.from(s.p.slice(-120)),
    events,
  };
  const k0 = Math.max(0, n - keep);
  const series = { d: s.d.slice(k0), c: Array.from(s.p.slice(k0)), s: Array.from(season.slice(k0)).join(''), p: ps.slice(k0).map(x => +x.toFixed(1)) };
  return { summary, series, s, season, z };
}

/** 9/22 코멘트의 읽는 법: 死 확률이 얕아지면 전환의 앞단, 旺 유지 중 확률이 낮고 떨어지면 약화 */
export function signalOf(s, ps, d5) {
  if (s === 3 && d5 != null && d5 <= -10) return { k: 'thaw', t: '전환 앞단', why: `死 확률 5일 ${d5.toFixed(0)}p — 死를 벗어나는 방향` };
  if (s === 3 && ps < 30) return { k: 'thaw', t: '死 얕음', why: `死 확률 ${ps.toFixed(0)}% — 판정이 약함` };
  if (s === 1 && ps < 30) return { k: 'weak', t: '旺 약화', why: `旺이지만 확률 ${ps.toFixed(0)}%` + (d5 != null && d5 < 0 ? `, 5일 ${d5.toFixed(0)}p` : '') };
  if (s === 1 && d5 != null && d5 <= -15) return { k: 'weak', t: '旺 약화', why: `旺 확률 5일 ${d5.toFixed(0)}p` };
  if (s === 0 && d5 != null && d5 >= 15) return { k: 'up', t: '生 강화', why: `生 확률 5일 +${d5.toFixed(0)}p` };
  return null;
}

/* ------------------------------ 학습 ------------------------------ */

/** labels × preds 채점. 0~1 가중 적중률 */
export function score(L, series, preds, detail = false) {
  let tot = 0, got = 0; const rows = [];
  const key = x => `${x.m}:${x.code}`;
  for (const x of L.entry) {
    const s = series[key(x)], pr = preds[key(x)]; if (!s) continue;
    const i = s.at(x.d), ph = S_IDX[x.ph]; if (i < WARMUP + 1) continue;
    let best = 0, at = null;
    for (let off = -3; off <= 3; off++) {
      const j = i + off;
      if (j >= 1 && j < pr.length && pr[j] === ph && pr[j - 1] !== ph) { const v = 1 - 0.15 * Math.abs(off); if (v > best) { best = v; at = s.d[j]; } }
    }
    if (best === 0 && pr[i] === ph) best = 0.35;
    tot += 1; got += best;
    if (detail) rows.push({ ...x, kind: 'entry', score: +best.toFixed(2), pred: SEASONS[pr[i]], predEntry: at });
  }
  for (const x of L.state) {
    const s = series[key(x)], pr = preds[key(x)]; if (!s) continue;
    const i = s.at(x.d); if (i < WARMUP + 1) continue;
    const v = x.phs.map(p => S_IDX[p]).includes(pr[i]) ? 1 : 0;
    tot += 1; got += v;
    if (detail) rows.push({ ...x, kind: 'state', score: v, pred: SEASONS[pr[i]] });
  }
  for (const x of L.range) {
    const s = series[key(x)], pr = preds[key(x)]; if (!s) continue;
    const a = s.at(x.a), b = s.at(x.b); if (a < WARMUP || b <= a) continue;
    let h = 0; for (let t = a; t <= b; t++) if (pr[t] === S_IDX[x.ph]) h++;
    const v = h / (b - a + 1);
    tot += 2; got += 2 * v;
    if (detail) rows.push({ ...x, kind: 'range', score: +v.toFixed(3) });
  }
  const acc = tot ? got / tot : 0;
  return detail ? { acc, rows, weight: tot } : acc;
}

const SPACE = { W: [10, 60, 1], b: [0, 0.08], u: [0.03, 0.4], d1: [0.03, 0.15], gap: [0.03, 0.3], TF: [3, 45, 1], TC: [3, 40, 1], vr: [1, 2] };
const toP = x => ({ W: x.W, b: x.b, u: x.u, d1: x.d1, d2: x.d1 + x.gap, TF: x.TF, TC: x.TC, vr: x.vr });
const fromP = P => ({ W: P.W, b: P.b, u: P.u, d1: P.d1, gap: Math.max(0.03, P.d2 - P.d1), TF: P.TF, TC: P.TC, vr: P.vr });

function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
function sample(r) { const x = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = lo + r() * (hi - lo); x[k] = int ? Math.round(v) : v; } return x; }
function perturb(x, r, sc) { const y = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { let v = Math.min(hi, Math.max(lo, x[k] + gauss(r) * (hi - lo) * sc)); y[k] = int ? Math.round(v) : v; } return y; }

function search(L, series, n, r, start) {
  const ev = x => { const P = toP(x); const preds = {}; for (const k in series) preds[k] = classify(series[k], P); return score(L, series, preds); };
  let best = start || fromP(DEFAULT_PARAMS), bs = ev(best);
  for (let i = 0; i < n * 0.6; i++) { const x = sample(r), v = ev(x); if (v > bs) { best = x; bs = v; } }
  const m = n * 0.4;
  for (let i = 0; i < m; i++) { const x = perturb(best, r, 0.12 * (1 - i / m) + 0.02), v = ev(x); if (v >= bs) { best = x; bs = v; } }
  return { best, bs };
}

/** barsByKey: {'US:VLO': {d,c,v}} → {params, fit, report, cal, anchors} */
export function train(L, barsByKey, { samples = 2500, folds = 3, seed = 7 } = {}) {
  const series = {};
  for (const [k, b] of Object.entries(barsByKey)) if (b && b.d.length > WARMUP + 20) series[k] = new Series(b.d, b.c, b.v);
  const r = rng(seed);
  const predsOf = P => { const o = {}; for (const k in series) o[k] = classify(series[k], P); return o; };
  const init = score(L, series, predsOf(DEFAULT_PARAMS), true);
  const { best } = search(L, series, samples, r);
  const P = toP(best), fit = score(L, series, predsOf(P), true);
  // k-fold 교차검증 (과적합 확인)
  const items = [...L.entry.map(x => ['entry', x]), ...L.state.map(x => ['state', x]), ...L.range.map(x => ['range', x])];
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  const cv = [];
  for (let f = 0; f < folds; f++) {
    const tr = { entry: [], state: [], range: [] }, te = { entry: [], state: [], range: [] };
    items.forEach(([k, x], i) => (i % folds === f ? te : tr)[k].push(x));
    const { best: b } = search(tr, series, Math.max(400, samples / 4 | 0), r);
    cv.push(score(te, series, predsOf(toP(b))));
  }
  const mean = cv.reduce((a, x) => a + x, 0) / cv.length, sd = Math.sqrt(cv.reduce((a, x) => a + (x - mean) ** 2, 0) / cv.length);
  const params = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, Number.isInteger(v) ? v : +v.toFixed(5)]));
  const { cal, anchors } = calibrateFromLabels(L, barsByKey, params);
  return {
    params, cal, anchors, trainedAt: new Date().toISOString(),
    fit: { initial: +init.acc.toFixed(4), train: +fit.acc.toFixed(4), cvMean: +mean.toFixed(4), cvStd: +sd.toFixed(4), weight: fit.weight, stocks: Object.keys(series).length },
    report: fit.rows, missing: L.stocks.map(x => `${x.m}:${x.code}`).filter(k => !series[k]),
  };
}

/** 스크린샷 앵커로 Ps 보정 — 규칙 판정 국면이 같을 때만 사용 */
export function calibrateFromLabels(L, barsByKey, P) {
  const anchors = [];
  for (const x of L.anchor) {
    const b = barsByKey[`${x.m}:${x.code}`];
    if (!b) { anchors.push({ ...x, season: x.ph, ok: false, why: '데이터 없음', z: null }); continue; }
    const s = new Series(b.d, b.c, b.v), season = classify(s, P), { F, z } = features(s, season), i = s.at(x.d);
    const exact = i >= 0 && s.d[i] === x.d, pred = i >= 0 ? SEASONS[season[i]] : null, ok = exact && pred === x.ph;
    anchors.push({ ...x, season: x.ph, pred, close: i >= 0 ? s.p[i] : null, z: i >= 0 ? +z[i].toFixed(3) : null, f: i >= 0 ? F[i] : null, ok,
      why: ok ? '' : !exact ? '해당일 봉 없음' : `규칙 판정이 ${pred} — DS 와 다름` });
  }
  const cal = calibrate(anchors);
  for (const a of anchors) { if (a.f && a.ok) a.modelPs = +psOf(S_IDX[a.season], a.f, cal).toFixed(1); delete a.f; }
  return { cal, anchors };
}
