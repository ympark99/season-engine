// 임계값 보정을 '하루 한 판'씩 나눠서 — 매번 유니버스에서 다른 표본을 뽑아 후보들을 채점하고,
// 여러 판에 걸친 평균 점수로 후보 풀을 갱신한다. 한 판이 함수 시간 안에 끝나므로 큰 데이터에서도 멈추지 않는다.
// 점수는 '계절을 맞히는가' — 사후 확정 국면 대비 균형 정확도(지연 허용)·치명 오류·확인 지연 [lib/truth.js].
// 수익 쪽 지표(여름·겨울 20일 초과수익)는 가드로만 쓴다: 여름이 겨울보다 못하면 감점.
import { classifyOf } from './engine2.js';
import { semantics } from './semantics.js';
import { truthOf, newAcc, accumulate, summarize, objectiveAcc } from './truth.js';

// v2 탐색 공간 — b·u·d1·d2 는 20일 변동성(σ20)의 배수
export const SPACE_VER = 3;                 // 3: 채점 기준을 사후 정답 대비 정확도로 바꿈
export const SPACE = { W: [10, 40, 1], b: [0.2, 1.5], u: [0.3, 2.0], d1: [0.5, 2.0], gap: [0.3, 2.0], TF: [10, 45, 1], TC: [3, 15, 1], hyst: [1, 4, 1], lowGate: [0, 0.4], slopeWin: [5, 20, 1] };
export const toP = x => ({ V: 2, W: x.W, b: x.b, u: x.u, d1: x.d1, d2: x.d1 + x.gap, TF: x.TF, TC: x.TC, hyst: x.hyst, lowGate: x.lowGate, slopeWin: x.slopeWin, vr: 1.2 });
export const fromP = P => ({ W: P.W, b: P.b, u: P.u, d1: P.d1, gap: Math.max(0.3, (P.d2 ?? P.d1 + 0.9) - P.d1), TF: P.TF, TC: P.TC, hyst: P.hyst ?? 2, lowGate: P.lowGate ?? 0.15, slopeWin: P.slopeWin ?? 10 });
export const roundP = P => Object.fromEntries(Object.entries(P).map(([k, v]) => [k, Number.isInteger(v) ? v : +v.toFixed(5)]));
export const rng = seed => { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
export const pick = r => { const x = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = lo + r() * (hi - lo); x[k] = int ? Math.round(v) : v; } return x; };
export const near = (x, r, sc) => { const y = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = Math.min(hi, Math.max(lo, x[k] + gauss(r) * (hi - lo) * sc)); y[k] = int ? Math.round(v) : v; } return y; };

const key = P => Object.values(P).map(v => (+v).toFixed(4)).join('|');
const mean = e => (e.n ? e.sum / e.n : -99);
const rank = e => mean(e) - 4 / Math.sqrt(Math.max(1, e.n));     // 한 표본에서만 잘 나온 후보는 뒤로 (재검증될수록 올라옴). 점수 단위가 %p 라 페널티도 그 단위

/** 후보 하나를 이번 표본으로 채점 — 앞 70% 기간(cut 이전)만 쓴다 */
function grade(items, P, { cut }) {
  const acc = newAcc();
  for (const it of items) {
    if (!it.truth) it.truth = truthOf(it.s).truth;                    // 정답지는 파라미터와 무관 — 한 번만
    accumulate(acc, it.s, classifyOf(it.s, P), it.truth, { to: cut });
  }
  const sum = summarize(acc), sem = semantics(items, P, { to: cut });
  const o = objectiveAcc(sum, sem);
  return { ...o, sem: { balanced: sum.balanced, tol: sum.tol, severe: sum.severe, lagS: sum.lag['여름'].avg, lagW: sum.lag['겨울'].avg,
    summerExc: sem['여름'].exc, winterExc: sem['겨울'].exc, share: Object.fromEntries(Object.entries(sum.by).map(([k, v]) => [k, v.share])) } };
}

/**
 * 한 판 실행. state 는 Redis 에 저장해 다음 판으로 이어짐.
 * @param items  이번 판 표본 (prep 결과)
 */
export function tuneRound(items, state, { budgetMs = 35000, curParams, cut = null, seed = null } = {}) {
  const t0 = Date.now();
  const st = state && state.pool && state.ver === SPACE_VER ? { ...state, pool: state.pool.map(e => ({ ...e })) } : { round: 0, off: 0, pool: [], history: [] };   // 판정기·채점 기준이 바뀌면 후보 풀은 버림
  const r = rng(seed ?? (st.round * 7919 + 13));
  const opt = { cut };
  const seen = new Map(st.pool.map(e => [key(e.P), e]));

  const put = (P, o) => {
    const k = key(P), e = seen.get(k) || { P, n: 0, sum: 0, best: null };
    e.n++; e.sum += o.score; e.last = o; e.best = e.best == null ? o.score : Math.max(e.best, o.score);
    seen.set(k, e); return e;
  };

  // 1) 현재 엔진 파라미터 — 비교 기준이라 매 판 채점
  const curO = grade(items, curParams, opt);
  const cur = put(curParams, curO);

  // 2) 기존 후보 재채점 (다른 표본에서도 좋은지 확인)
  for (const e of [...seen.values()].filter(e => e !== cur).slice(0, 8)) {
    if (Date.now() - t0 > budgetMs * 0.45) break;
    put(e.P, grade(items, e.P, opt));
  }

  // 3) 새 후보 — 상위 후보 주변 절반, 완전 무작위 절반
  let tried = 0;
  const top = () => [...seen.values()].sort((a, b) => rank(b) - rank(a))[0];
  while (Date.now() - t0 < budgetMs) {
    const base = top();
    const x = tried % 2 === 0 && base ? near(fromP(base.P), r, 0.12) : pick(r);
    const P = roundP(toP(x));
    put(P, grade(items, P, opt));
    tried++;
  }

  const pool = [...seen.values()].sort((a, b) => rank(b) - rank(a)).slice(0, 10)
    .map(e => ({ P: e.P, n: e.n, sum: +e.sum.toFixed(3), avg: +mean(e).toFixed(3), best: +(e.best ?? 0).toFixed(3), last: e.last }));
  const verified = pool.filter(e => e.n >= 3).sort((a, b) => b.avg - a.avg)[0] || null;
  const bestE = pool[0];
  return {
    ver: SPACE_VER, round: st.round + 1, off: st.off, pool, tried, at: new Date().toISOString(),
    cur: { P: curParams, avg: +mean(cur).toFixed(3), n: cur.n, last: curO }, candidate: verified,
    history: [...(st.history || []), { at: new Date().toISOString(), round: st.round + 1, nSym: items.length, best: bestE?.avg ?? null, cur: +mean(cur).toFixed(3), tried }].slice(-60),
  };
}

/** 적용할 만한가 — 여러 판 평균이 현재보다 확실히 좋고, 충분히 여러 번 검증됐을 때만 */
export function readyToApply(state, { minRounds = 3, margin = 1.5 } = {}) {
  const cur = state?.cur, best = (state?.pool || []).filter(e => e.n >= minRounds).sort((a, b) => b.avg - a.avg)[0];
  if (!cur) return { ok: false, why: '아직 판이 부족해' };
  if (!best) return { ok: false, why: `${minRounds}판 이상 검증된 후보가 아직 없어 (다음 판에서 재검증돼)` };
  if (best.avg < cur.avg + margin) return { ok: false, why: `개선폭 ${(best.avg - cur.avg).toFixed(2)} (기준 ${margin})` };
  return { ok: true, why: `${best.n}판 평균 ${best.avg} vs 현재 ${cur.avg}` };
}
