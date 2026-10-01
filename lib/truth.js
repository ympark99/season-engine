// 사후 확정 국면 — 엔진이 '계절을 맞혔는지' 채점하기 위한 정답지.
// 엔진은 그날까지의 가격만 보고 판정하지만, 정답지는 그 뒤 가격까지 다 보고(사후에) 정한다.
//
// 만드는 법
//   1) 지그재그로 큰 파동의 꼭지·바닥을 찾는다. 파동 기준 θ = max(12%, 2.5 × 그 종목 20일 변동성 중앙값), 최대 45%.
//      (변동성이 큰 종목은 큰 파동만, 지수처럼 덜 움직이는 건 작은 파동도 파동으로 친다)
//   2) 바닥 L → 꼭지 H 상승 파동: 진행률 φ = ln(p/L) / ln(H/L)
//        φ < 0.2  봄 (바닥권 — 막 올라오기 시작)   0.2 ≤ φ < 0.8  여름 (본격 상승)   φ ≥ 0.8  가을 (꼭지권)
//      꼭지 H → 바닥 L 하락 파동: 진행률 ψ = ln(H/p) / ln(H/L)
//        ψ < 0.2  가을 (꼭지권 — 막 꺾이기 시작)   0.2 ≤ ψ < 0.8  겨울 (본격 하락)   ψ ≥ 0.8  봄 (바닥권)
//   3) 마지막 꼭지·바닥 이후는 파동이 아직 안 끝나 정답을 모른다 → 채점에서 뺀다 (-1).
//
// 채점
//   엄격 일치   엔진 국면 == 그날 정답
//   지연 허용   엔진 국면 == 최근 L일(기본 10거래일) 안 어느 날의 정답 — 추세추종은 원래 늦게 확인하므로 그만큼은 봐준다
//   균형 정확도 국면별 맞힌 비율(재현율)의 평균 — 겨울이 많은 장에서 '늘 겨울'이라고 찍어서 점수를 따는 걸 막는다
//   치명 오류   정답이 겨울인데 엔진이 여름이라 하거나, 정답이 여름인데 엔진이 겨울이라 한 날의 비율
//   확인 지연   정답 여름·겨울 구간이 시작된 뒤 엔진이 같은 국면을 처음 말하기까지 걸린 거래일 (놓치면 구간 길이)
import { sigma20 } from './engine2.js';

export const ZONE = 0.2;                 // 파동 앞뒤 20% 를 바닥권·꼭지권으로 본다
export const LAG_OK = 10;                // 지연 허용 거래일
const WARMUP = 60;

/** 지그재그 꼭지·바닥 [{i, hi:boolean}] — 마지막 꼭지·바닥은 반대 방향으로 θ 만큼 움직여야 확정 */
export function pivots(p, theta) {
  const n = p.length, out = [];
  if (n < 3) return out;
  let dir = 0, ext = 0;                  // dir: +1 상승 중(꼭지 찾는 중), -1 하락 중
  let lo = 0, hi = 0;
  for (let t = 1; t < n; t++) {
    if (dir === 0) {
      if (p[t] > p[hi]) hi = t;
      if (p[t] < p[lo]) lo = t;
      if (p[hi] / p[lo] - 1 >= theta) {
        if (lo < hi) { out.push({ i: lo, hi: false }); dir = 1; ext = hi; }
        else { out.push({ i: hi, hi: true }); dir = -1; ext = lo; }
      }
      continue;
    }
    if (dir === 1) {
      if (p[t] >= p[ext]) ext = t;
      else if (p[t] <= p[ext] * (1 - theta / (1 + theta))) { out.push({ i: ext, hi: true }); dir = -1; ext = t; }
    } else {
      if (p[t] <= p[ext]) ext = t;
      else if (p[t] >= p[ext] * (1 + theta)) { out.push({ i: ext, hi: false }); dir = 1; ext = t; }
    }
  }
  return out;
}

/** 종목별 파동 기준 */
export function thetaOf(s) {
  const sig = Array.from(sigma20(s)).slice(WARMUP).sort((a, b) => a - b);
  const med = sig.length ? sig[sig.length >> 1] : 0.08;
  return Math.min(0.45, Math.max(0.12, 2.5 * med));
}

/** 사후 정답 국면 (Int8Array, 모르는 날 -1). 0 봄 1 여름 2 가을 3 겨울 */
export function truthOf(s, { zone = ZONE } = {}) {
  const p = s.p, n = p.length, out = new Int8Array(n).fill(-1);
  const th = thetaOf(s), pv = pivots(p, th);
  for (let k = 0; k + 1 < pv.length; k++) {
    const a = pv[k], b = pv[k + 1], pa = p[a.i], pb = p[b.i], span = Math.log(Math.max(pa, pb) / Math.min(pa, pb)) || 1e-9;
    for (let t = a.i; t < b.i; t++) {
      if (!a.hi) {                         // 상승 파동 (바닥 → 꼭지)
        const f = Math.log(p[t] / pa) / span;
        out[t] = f < zone ? 0 : f < 1 - zone ? 1 : 2;
      } else {                             // 하락 파동 (꼭지 → 바닥)
        const f = Math.log(pa / p[t]) / span;
        out[t] = f < zone ? 2 : f < 1 - zone ? 3 : 0;
      }
    }
    out[b.i] = b.hi ? 2 : 0;
  }
  return { truth: out, theta: +th.toFixed(3), pivots: pv.length };
}

/** 빈 누적기 — 여러 종목·여러 조각에 걸쳐 더한다 */
export const newAcc = () => ({
  n: 0, strict: 0, tol: 0, severe: 0,
  conf: [0, 1, 2, 3].map(() => [0, 0, 0, 0]),      // conf[정답][엔진] — 엄격
  tolBy: [0, 0, 0, 0], nBy: [0, 0, 0, 0],          // 정답 국면별 지연 허용 적중·표본
  lag: { 1: { n: 0, sum: 0, miss: 0 }, 3: { n: 0, sum: 0, miss: 0 } },
  dwell: [0, 1, 2, 3].map(() => ({ n: 0, sum: 0 })), // 엔진 국면 평균 체류일 (완료된 구간)
  syms: 0,
});

/**
 * 한 종목 채점을 누적. season = 엔진 판정, truth = truthOf 결과
 * from/to 로 날짜 창 제한 가능 (보정 때 앞 70% 만 쓰는 용도)
 */
export function accumulate(acc, s, season, truth, { from = null, to = null, L = LAG_OK } = {}) {
  const n = s.p.length, inWin = t => (!from || s.d[t] >= from) && (!to || s.d[t] <= to);
  acc.syms++;
  for (let t = WARMUP; t < n; t++) {
    const g = truth[t];
    if (g < 0 || !inWin(t)) continue;
    const e = season[t];
    acc.n++; acc.conf[g][e]++; acc.nBy[g]++;
    if (e === g) acc.strict++;
    let ok = e === g;
    for (let u = Math.max(0, t - L); !ok && u < t; u++) if (truth[u] === e) ok = true;
    if (ok) { acc.tol++; acc.tolBy[g]++; }
    if ((g === 3 && e === 1) || (g === 1 && e === 3)) {
      // 지연 허용 안에서 정답이 그 국면이었으면 치명 오류로 보지 않는다 (전환 직후 늦게 따라간 것)
      if (!ok) acc.severe++;
    }
  }
  // 확인 지연 — 정답 여름·겨울 구간(10일 이상)이 시작된 뒤 엔진이 처음 같은 국면을 말할 때까지
  for (let t = WARMUP; t < n; ) {
    const g = truth[t];
    let u = t; while (u < n && truth[u] === g) u++;
    if ((g === 1 || g === 3) && u - t >= 10 && inWin(t)) {
      let k = t; while (k < u && season[k] !== g) k++;
      const c = acc.lag[g]; c.n++;
      if (k >= u) { c.miss++; c.sum += u - t; } else c.sum += k - t;
    }
    t = u;
  }
  // 엔진 국면 체류일
  for (let t = WARMUP + 1, a = WARMUP; t <= n; t++) {
    if (t === n || season[t] !== season[a]) {
      if (t < n && a > WARMUP && inWin(a)) { const d = acc.dwell[season[a]]; d.n++; d.sum += t - a; }
      a = t;
    }
  }
  return acc;
}

export function mergeAcc(a, b) {
  const o = newAcc();
  for (const x of [a, b]) {
    if (!x) continue;
    o.n += x.n; o.strict += x.strict; o.tol += x.tol; o.severe += x.severe; o.syms += x.syms;
    for (let i = 0; i < 4; i++) { o.tolBy[i] += x.tolBy[i]; o.nBy[i] += x.nBy[i]; o.dwell[i].n += x.dwell[i].n; o.dwell[i].sum += x.dwell[i].sum; for (let j = 0; j < 4; j++) o.conf[i][j] += x.conf[i][j]; }
    for (const k of [1, 3]) { o.lag[k].n += x.lag[k].n; o.lag[k].sum += x.lag[k].sum; o.lag[k].miss += x.lag[k].miss; }
  }
  return o;
}

const NAMES = ['봄', '여름', '가을', '겨울'];
/** 누적기 → 표 */
export function summarize(acc) {
  const pc = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
  const recall = NAMES.map((_, g) => (acc.nBy[g] ? acc.tolBy[g] / acc.nBy[g] : null));
  const rs = recall.filter(v => v != null);
  const colSum = j => acc.conf.reduce((a, r) => a + r[j], 0);
  return {
    n: acc.n, syms: acc.syms,
    strict: pc(acc.strict, acc.n), tol: pc(acc.tol, acc.n),
    balanced: rs.length ? +(100 * rs.reduce((a, x) => a + x, 0) / rs.length).toFixed(1) : null,
    severe: pc(acc.severe, acc.n),
    by: Object.fromEntries(NAMES.map((s, g) => [s, {
      truthN: acc.nBy[g], recall: recall[g] == null ? null : +(100 * recall[g]).toFixed(1),       // 정답이 이 국면인 날 중 맞힌 비율 (지연 허용)
      precision: pc(acc.conf[g][g], colSum(g)),                                                    // 엔진이 이 국면이라 한 날 중 정답도 이 국면 (엄격)
      share: pc(colSum(g), acc.n), truthShare: pc(acc.nBy[g], acc.n),
      dwell: acc.dwell[g].n ? +(acc.dwell[g].sum / acc.dwell[g].n).toFixed(1) : null,
    }])),
    lag: Object.fromEntries([1, 3].map(k => [NAMES[k], { n: acc.lag[k].n, avg: acc.lag[k].n ? +(acc.lag[k].sum / acc.lag[k].n).toFixed(1) : null, miss: pc(acc.lag[k].miss, acc.lag[k].n) }])),
    conf: acc.conf,
  };
}

/**
 * 보정 목적함수 — 계절을 얼마나 맞히나.
 *   균형 정확도(지연 허용) − 1.5 × 치명 오류 − 0.3 × (여름·겨울 평균 확인 지연일) − 0.2 × (여름·겨울 놓친 비율)
 * 경제적 쓸모 확인(가드): 여름 진입 뒤 20일 초과수익이 겨울 진입 뒤보다 낮으면 감점.
 * 한 국면이 3% 미만이면 판정이 쏠린 것 → 탈락.
 */
export function objectiveAcc(sum, sem = null) {
  if (!sum || !sum.n) return { score: -99, why: '채점할 날이 없어' };
  const thin = Math.min(...NAMES.map(s => sum.by[s].share ?? 0));
  if (thin < 3) return { score: -99, why: '한 국면이 3% 미만 — 쏠린 판정' };
  const lagS = sum.lag['여름'].avg ?? 30, lagW = sum.lag['겨울'].avg ?? 30;
  const missS = sum.lag['여름'].miss ?? 100, missW = sum.lag['겨울'].miss ?? 100;
  const parts = {
    balanced: sum.balanced ?? 0,
    severe: -1.5 * (sum.severe ?? 0),
    lag: -0.3 * (lagS + lagW) / 2,
    miss: -0.2 * (missS + missW) / 2,
    guard: sem && sem['여름']?.exc != null && sem['겨울']?.exc != null && sem['여름'].exc < sem['겨울'].exc ? -5 : 0,
  };
  const score = Object.values(parts).reduce((a, x) => a + x, 0);
  return { score: +score.toFixed(2), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(2)])) };
}

/* ---------------- 확률 Ps 보정 — '이 판정이 사후에 맞을 확률' ----------------
   국면별로 국면다움 점수 z 를 구간으로 나눠 (지연 허용) 적중 횟수를 센 다음, logit(Ps) = a + b·z 를 맞춘다. */
export const ZBINS = [-4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 4];
export const newCalAcc = () => NAMES.map(() => ZBINS.map(() => [0, 0]));     // [n, ok]
export function binOf(z) { let k = 0; while (k + 1 < ZBINS.length && z >= ZBINS[k + 1]) k++; return k; }
export function calAccumulate(cacc, s, season, truth, z, { from = null, to = null, L = LAG_OK } = {}) {
  const n = s.p.length;
  for (let t = WARMUP; t < n; t++) {
    const g = truth[t];
    if (g < 0 || (from && s.d[t] < from) || (to && s.d[t] > to)) continue;
    const e = season[t];
    let ok = e === g;
    for (let u = Math.max(0, t - L); !ok && u < t; u++) if (truth[u] === e) ok = true;
    const c = cacc[e][binOf(z[t])]; c[0]++; if (ok) c[1]++;
  }
  return cacc;
}
export function mergeCal(a, b) {
  return NAMES.map((_, s) => ZBINS.map((_, k) => [(a?.[s]?.[k]?.[0] || 0) + (b?.[s]?.[k]?.[0] || 0), (a?.[s]?.[k]?.[1] || 0) + (b?.[s]?.[k]?.[1] || 0)]));
}
/** 구간 집계 → 국면별 {a, b} (가중 로지스틱 회귀, 뉴턴법). 표본이 적으면 기본값 */
export function fitCal(cacc) {
  const cal = {};
  NAMES.forEach((name, s) => {
    const pts = ZBINS.map((lo, k) => ({ z: lo + 0.25, n: cacc[s][k][0], y: cacc[s][k][1] })).filter(p => p.n > 0);
    const N = pts.reduce((a, p) => a + p.n, 0), K = pts.reduce((a, p) => a + p.y, 0);
    if (N < 200) { cal[name] = { a: 0, b: 1.2, how: `표본 부족(${N}) — 기본 식`, n: N }; return; }
    let a = Math.log((K + 1) / (N - K + 1)), b = 0;
    for (let it = 0; it < 30; it++) {
      let g0 = 0, g1 = 0, h00 = 1e-3, h01 = 0, h11 = 1e-3 + 0.5;      // 약한 ridge (b 쪽)
      for (const p of pts) {
        const q = 1 / (1 + Math.exp(-(a + b * p.z))), w = p.n * q * (1 - q);
        g0 += p.y - p.n * q; g1 += (p.y - p.n * q) * p.z;
        h00 += w; h01 += w * p.z; h11 += w * p.z * p.z;
      }
      g1 -= 0.5 * b;
      const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break;
      const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
      a += da; b += db;
      if (Math.abs(da) + Math.abs(db) < 1e-6) break;
    }
    const hit = +(100 * K / N).toFixed(1);
    cal[name] = { a: +a.toFixed(4), b: +b.toFixed(4), how: `사후 정답 대비 실측 — 표본 ${N.toLocaleString()}일, 평균 적중 ${hit}%`, n: N, hit,
      bins: pts.map(p => ({ z: +p.z.toFixed(2), n: p.n, hit: +(100 * p.y / p.n).toFixed(1) })) };
  });
  return cal;
}
