// 국면 판정 v2 (실제 판정기).
// v1(초기 판정기)의 문제: 겨울 탈출 조건이 '직전 W일 최고가를 b(3~4.6%) 이상 갭 돌파 + 거래량 1.2배'라서
//             꾸준히 오르는 지수·ETF 는 조건을 영영 못 만족하고 5년 내내 겨울에 갇혔다.
// v2 의 해법: (1) 임계값을 % 가 아니라 그 종목 20일 변동성(σ20)의 배수로 쓴다 → 지수든 고변동 성장주든 같은 값이 통한다.
//             (2) 판정을 이동평균 구조(20/60/120 정배열, 60일선 기울기)로 한다 → 미너비니 1~4단계와 대응.
//             (3) 정배열 + 고점 근처면 겨울에서 강제 탈출 (갇힘 방지). 거래량은 필수 조건에서 뺀다.
import { SEASONS, Series, sma, features, psOf, logitOf, signalOf } from './engine.js';

const WARMUP = 60;
export const DEFAULT_PARAMS_V2 = { V: 2, W: 20, b: 0.55, u: 0.70, d1: 1.00, d2: 1.90, TF: 25, TC: 5, vr: 1.2, hyst: 2, lowGate: 0.15, slopeWin: 10 };

const CA = new WeakMap();                      // Series 별 v2 캐시 (engine.js 를 건드리지 않으려고 밖에 둔다)
const cache = s => { let c = CA.get(s); if (!c) { c = { ma: new Map(), hl: new Map(), sig: null }; CA.set(s, c); } return c; };
export const maOf = (s, k) => { const c = cache(s); if (!c.ma.has(k)) c.ma.set(k, sma(s.p, k)); return c.ma.get(k); };

/** 최근 20일 일간 수익률 표준편차 × √20 = '보통 20일이면 이만큼 움직인다' (3~25% 로 제한) */
export function sigma20(s) {
  const c = cache(s);
  if (c.sig) return c.sig;
  const n = s.p.length, o = new Float64Array(n), r = new Float64Array(n);
  for (let t = 1; t < n; t++) r[t] = Math.log(s.p[t] / s.p[t - 1]);
  let s1 = 0, s2 = 0;
  for (let t = 1; t < n; t++) {
    s1 += r[t]; s2 += r[t] * r[t];
    if (t > 20) { s1 -= r[t - 20]; s2 -= r[t - 20] * r[t - 20]; }
    const k = Math.min(t, 20), m = s1 / k, v = Math.max(0, s2 / k - m * m);
    o[t] = Math.min(0.25, Math.max(0.03, Math.sqrt(v) * Math.sqrt(20)));
  }
  o[0] = o[1] || 0.09;
  return (c.sig = o);
}

/** 최근 k봉 최고·최저 (t 포함) */
export function hilo(s, k) {
  const c = cache(s);
  if (c.hl.has(k)) return c.hl.get(k);
  const n = s.p.length, hi = new Float64Array(n), lo = new Float64Array(n), qh = [], ql = [];
  for (let t = 0; t < n; t++) {
    while (qh.length && qh[0] <= t - k) qh.shift();
    while (ql.length && ql[0] <= t - k) ql.shift();
    while (qh.length && s.p[qh[qh.length - 1]] <= s.p[t]) qh.pop();
    while (ql.length && s.p[ql[ql.length - 1]] >= s.p[t]) ql.pop();
    qh.push(t); ql.push(t);
    hi[t] = s.p[qh[0]]; lo[t] = s.p[ql[0]];
  }
  const r = { hi, lo }; c.hl.set(k, r); return r;
}

/**
 * v2 판정기 (미너비니 1~4단계 대응)
 *   봄   바닥에서 60일선 위로 올라오고 60일선이 돌아섬 — 여름 진입 각을 보는 자리
 *   여름 20>60>120 정배열 + 돌파가 대비 σ배 상승 + 52주 저점에서 lowGate 이상 올라옴 — 폭발 구간
 *   가을 국면 고점 대비 d1·σ 낙폭이거나 20일선 이탈 — 추세 훼손
 *   겨울 60일선 아래 + 60일선 하락, 또는 고점 대비 d2·σ 낙폭 — 하락 후 횡보
 */
export function classifyV2(s, P) {
  const { p } = s, n = p.length;
  const m20 = maOf(s, 20), m60 = maOf(s, 60), m120 = maOf(s, Math.min(120, Math.max(60, (n / 4) | 0)) || 120);
  const sig = sigma20(s), hw = s.hw(P.W | 0), { hi, lo } = hilo(s, 252);
  const SW = P.slopeWin || 10, HY = Math.max(1, P.hyst || 2), lowGate = P.lowGate ?? 0.15;
  const out = new Int8Array(n).fill(3);
  let st = 3, bp = p[0], pk = p[0], t0 = 0, since = 0, streak = 0, want = -1;
  for (let t = 0; t < n; t++) {
    if (t < WARMUP) { out[t] = st; continue; }
    const x = p[t], S = sig[t];
    const up20 = m20[t] > m20[t - SW], up60 = m60[t] > m60[t - 2 * SW];
    const align = m20[t] > m60[t] && m60[t] > m120[t];
    const dd = x / hi[t] - 1, up52 = lo[t] > 0 ? x / lo[t] - 1 : 0;
    let next = st;
    if (st === 3) {                                   // 겨울 → 봄
      if ((x > m60[t] && up60 && (x >= hw[t] * (1 + P.b * S) || x / m60[t] - 1 > 0.5 * P.b * S)) ||
          (align && dd > -0.10)) next = 0;            // 정배열 + 고점 근처면 무조건 탈출
    } else if (st === 0) {                            // 봄 → 여름 / 실패 시 겨울
      if (align && up20 && x >= bp * (1 + P.u * S) && up52 >= lowGate && dd > -0.15) next = 1;
      else if (x <= bp * (1 - P.d1 * S) || (x < m60[t] && !up60)) next = 3;
    } else if (st === 1) {                            // 여름 → 가을
      if (x > pk) pk = x;
      if (x <= pk * (1 - P.d1 * S) || (x < m20[t] && !up20)) next = 2;
    } else {                                          // 가을 → 여름 회복 / 겨울 이탈 / 체류 초과
      if (x > pk && x > m20[t]) next = 1;
      else if (x <= pk * (1 - P.d2 * S) || (x < m60[t] && !up60) || t - t0 > P.TF) next = 3;
    }
    if (next !== st) {                                // 연속 HY일 충족 + 직전 전환 후 TC일 경과라야 전환
      streak = next === want ? streak + 1 : 1; want = next;
      const forced = st === 3 && next === 0 && align && dd > -0.10;
      if ((streak >= HY && since >= P.TC) || forced) {
        if (next === 0) bp = x;
        if (next === 1) pk = Math.max(pk, x);
        if (next === 2) t0 = t;
        if (next === 3) { bp = x; pk = x; }
        st = next; since = 0; streak = 0; want = -1;
      }
    } else { streak = 0; want = -1; }
    since++;
    if (st === 1 && x > pk) pk = x;
    out[t] = st;
  }
  return out;
}

/** 판정기 — v2 하나만 쓴다 (예전 파라미터가 와도 v2 기본값으로 채워서) */
export const classifyOf = (s, P) => classifyV2(s, P?.V === 2 ? P : { ...DEFAULT_PARAMS_V2, ...(P || {}), V: 2 });

const runsOf = season => {
  const out = []; let a = 0;
  for (let t = 1; t <= season.length; t++) if (t === season.length || season[t] !== season[a]) { out.push([season[a], a, t - 1]); a = t; }
  return out;
};

/** 목록·상세용 분석 결과 (engine.js analyze 와 같은 모양, 판정만 v2) */
export function analyzeV2(bars, P, cal, keep = 1265) {
  const s = new Series(bars.d, bars.c, bars.v);
  const season = classifyOf(s, P), { F, z } = features(s, season), n = s.p.length;
  const ps = Array.from(season, (x, t) => psOf(x, F[t], cal));
  const runs = runsOf(season), cur = runs[runs.length - 1], prev = runs[runs.length - 2] || cur;
  let hi = 0; for (let t = Math.max(0, n - 252); t < n; t++) hi = Math.max(hi, s.p[t]);
  let segPk = 0; for (let t = cur[1]; t < n; t++) segPk = Math.max(segPk, s.p[t]);
  const events = [];
  for (let i = 1; i < runs.length; i++) if (runs[i][1] >= n - 20) events.push({ d: s.d[runs[i][1]], from: SEASONS[runs[i - 1][0]], to: SEASONS[runs[i][0]] });
  const summary = {
    last: s.p[n - 1], lastDate: s.d[n - 1], firstDate: s.d[Math.max(0, n - keep)], bars: Math.min(n, keep),
    season: SEASONS[cur[0]], prob: Math.round(ps[n - 1]), psRaw: +ps[n - 1].toFixed(2), z: +z[n - 1].toFixed(3),
    logit: +logitOf(cur[0], F[n - 1], cal).toFixed(3),
    ps5: n > 5 && season[n - 6] === cur[0] ? +(ps[n - 1] - ps[n - 6]).toFixed(1) : null,
    ps1: n > 1 && season[n - 2] === cur[0] ? +(ps[n - 1] - ps[n - 2]).toFixed(1) : null,      // 전 거래일 대비 (같은 국면 안에서만)
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
