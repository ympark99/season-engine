// 생왕쇠사 엔진 공용 부품 — 시계열(Series), 피처, 국면다움 점수 z, 확률 Ps.
// 국면 코드: 0=봄(生) 1=여름(旺) 2=가을(衰) 3=겨울(死). 국면 판정 자체는 engine2.js(classifyV2).
// Ps 는 '이 판정이 사후에 맞을 확률' — 유니버스에서 사후 확정 국면(lib/truth.js) 대비 실측해서 국면별 a·b 를 맞춘다.

export const SEASONS = ['봄', '여름', '가을', '겨울'];
export const S_IDX = { 봄: 0, 여름: 1, 가을: 2, 겨울: 3 };
const T_DWELL = [40, 120, 20, 60];

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

/** 보정 전 기본값 — logit(Ps) = a + b·z */
export const DEFAULT_CAL = Object.fromEntries(SEASONS.map(s => [s, { a: 0, b: 1.2, how: '기본 식 (실측 보정 전)' }]));

/** 확률 읽는 법: 死 확률이 얕아지면 전환의 앞단, 旺 유지 중 확률이 낮고 떨어지면 약화 */
export function signalOf(s, ps, d5) {
  if (s === 3 && d5 != null && d5 <= -10) return { k: 'thaw', t: '전환 앞단', why: `死 확률 5일 ${d5.toFixed(0)}p — 死를 벗어나는 방향` };
  if (s === 3 && ps < 30) return { k: 'thaw', t: '死 얕음', why: `死 확률 ${ps.toFixed(0)}% — 판정이 약함` };
  if (s === 1 && ps < 30) return { k: 'weak', t: '旺 약화', why: `旺이지만 확률 ${ps.toFixed(0)}%` + (d5 != null && d5 < 0 ? `, 5일 ${d5.toFixed(0)}p` : '') };
  if (s === 1 && d5 != null && d5 <= -15) return { k: 'weak', t: '旺 약화', why: `旺 확률 5일 ${d5.toFixed(0)}p` };
  if (s === 0 && d5 != null && d5 >= 15) return { k: 'up', t: '生 강화', why: `生 확률 5일 +${d5.toFixed(0)}p` };
  return null;
}

