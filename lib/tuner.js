// 임계값 보정을 '하루 한 판'씩 나눠서 — 매번 유니버스에서 다른 표본을 뽑아 후보들을 채점하고,
// 여러 판에 걸친 평균 점수로 후보 풀을 갱신한다. 한 판이 함수 시간 안에 끝나므로 큰 데이터에서도 멈추지 않는다.
// 점수 = 旺−死 초과수익 간격 − w1·(DS 공개 분포와의 거리) + w2·(DS 라벨 재현율)   [lib/backtest.js objective]
import { evaluate, objective, snapshotDist, DS_DIST } from './backtest.js';

export const SPACE = { W: [10, 60, 1], b: [0, 0.08], u: [0.03, 0.4], d1: [0.03, 0.15], gap: [0.03, 0.3], TF: [3, 45, 1], TC: [3, 40, 1], vr: [1, 2] };
export const toP = x => ({ W: x.W, b: x.b, u: x.u, d1: x.d1, d2: x.d1 + x.gap, TF: x.TF, TC: x.TC, vr: x.vr });
export const fromP = P => ({ W: P.W, b: P.b, u: P.u, d1: P.d1, gap: Math.max(0.03, P.d2 - P.d1), TF: P.TF, TC: P.TC, vr: P.vr });
export const roundP = P => Object.fromEntries(Object.entries(P).map(([k, v]) => [k, Number.isInteger(v) ? v : +v.toFixed(5)]));
export const rng = seed => { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
export const pick = r => { const x = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = lo + r() * (hi - lo); x[k] = int ? Math.round(v) : v; } return x; };
export const near = (x, r, sc) => { const y = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = Math.min(hi, Math.max(lo, x[k] + gauss(r) * (hi - lo) * sc)); y[k] = int ? Math.round(v) : v; } return y; };

const key = P => Object.values(P).map(v => (+v).toFixed(4)).join('|');
const mean = e => (e.n ? e.sum / e.n : -99);
const rank = e => mean(e) - 1.2 / Math.sqrt(Math.max(1, e.n));   // 한 표본에서만 잘 나온 후보는 뒤로 (재검증될수록 올라옴)

/** 후보 하나를 이번 표본으로 채점 */
function grade(items, P, { target, dsAcc, cut, wDist, wDs }) {
  const ev = evaluate(items, P, { horizons: [20], to: cut });
  return objective(ev, { dist: snapshotDist(items, P), target, dsAcc, wDist, wDs });
}

/**
 * 한 판 실행. state 는 Redis 에 저장해 다음 판으로 이어짐.
 * @param items  이번 판 표본 (prep 결과)
 * @param dsAccOf  파라미터 → DS 라벨 재현율 함수
 */
export function tuneRound(items, dsAccOf, state, { budgetMs = 35000, target = DS_DIST, curParams, cut = null, wDist = 0.06, wDs = 5, seed = null } = {}) {
  const t0 = Date.now();
  const st = state && state.pool ? { ...state, pool: state.pool.map(e => ({ ...e })) } : { round: 0, off: 0, pool: [], history: [] };
  const r = rng(seed ?? (st.round * 7919 + 13));
  const opt = { target, cut, wDist, wDs };
  const seen = new Map(st.pool.map(e => [key(e.P), e]));

  const put = (P, o) => {
    const k = key(P), e = seen.get(k) || { P, n: 0, sum: 0, best: null };
    e.n++; e.sum += o.score; e.last = o; e.best = e.best == null ? o.score : Math.max(e.best, o.score);
    seen.set(k, e); return e;
  };

  // 1) 현재 엔진 파라미터 — 비교 기준이라 매 판 채점
  const curO = grade(items, curParams, { ...opt, dsAcc: dsAccOf(curParams) });
  const cur = put(curParams, curO);

  // 2) 기존 후보 재채점 (다른 표본에서도 좋은지 확인)
  for (const e of [...seen.values()].filter(e => e !== cur).slice(0, 8)) {
    if (Date.now() - t0 > budgetMs * 0.45) break;
    put(e.P, grade(items, e.P, { ...opt, dsAcc: dsAccOf(e.P) }));
  }

  // 3) 새 후보 — 상위 후보 주변 절반, 완전 무작위 절반
  let tried = 0;
  const top = () => [...seen.values()].sort((a, b) => rank(b) - rank(a))[0];
  while (Date.now() - t0 < budgetMs) {
    const base = top();
    const x = tried % 2 === 0 && base ? near(fromP(base.P), r, 0.12) : pick(r);
    const P = roundP(toP(x));
    put(P, grade(items, P, { ...opt, dsAcc: dsAccOf(P) }));
    tried++;
  }

  const pool = [...seen.values()].sort((a, b) => rank(b) - rank(a)).slice(0, 10)
    .map(e => ({ P: e.P, n: e.n, sum: +e.sum.toFixed(3), avg: +mean(e).toFixed(3), best: +(e.best ?? 0).toFixed(3), last: e.last }));
  const verified = pool.filter(e => e.n >= 3).sort((a, b) => b.avg - a.avg)[0] || null;
  const bestE = pool[0];
  const out = {
    round: st.round + 1, off: st.off, pool, tried, at: new Date().toISOString(),
    cur: { P: curParams, avg: +mean(cur).toFixed(3), n: cur.n, last: curO }, candidate: verified,
    history: [...(st.history || []), { at: new Date().toISOString(), round: st.round + 1, nSym: items.length, best: bestE?.avg ?? null, cur: +mean(cur).toFixed(3), tried }].slice(-60),
  };
  return out;
}

/** 적용할 만한가 — 여러 판 평균이 현재보다 확실히 좋고, 충분히 여러 번 검증됐을 때만 */
export function readyToApply(state, { minRounds = 3, margin = 0.3 } = {}) {
  const cur = state?.cur, best = (state?.pool || []).filter(e => e.n >= minRounds).sort((a, b) => b.avg - a.avg)[0];
  if (!cur) return { ok: false, why: '아직 판이 부족해' };
  if (!best) return { ok: false, why: `${minRounds}판 이상 검증된 후보가 아직 없어 (다음 판에서 재검증떄)` };
  if (best.avg < cur.avg + margin) return { ok: false, why: `개선폭 ${(best.avg - cur.avg).toFixed(2)} (기준 ${margin})` };
  return { ok: true, why: `${best.n}판 평균 ${best.avg} vs 현재 ${cur.avg}` };
}
