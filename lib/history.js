// 국면 변경 내역 — 진입일 종가 기준 수익률 (engine.analyze 결과 {s, season} 로 계산)
//   r[N]  = 진입 후 N거래일 뒤 종가 (국면이 그 전에 바뀌어도 N일 그대로, 아직 안 지났으면 null)
//   rEnd  = 다음 국면이 판정된 날 종가까지 (진행 중이면 마지막 종가) — 진입일 종가에 사서 전환 확인일 종가에 판 셈
//   mdd/mx = 국면 기간 중 진입가 대비 최저·최고
import { SEASONS, features, psOf } from './engine.js';

export const HIST_N = [5, 10, 20, 60, 120];
const WARMUP = 60;

export function historyOf({ s, season }, cal, keep = 1265) {
  const n = s.p.length, P = s.p, from = Math.max(0, n - keep), out = [];
  const { F } = features(s, season), runs = [];
  let a0 = 0;
  for (let t = 1; t <= n; t++) if (t === n || season[t] !== season[a0]) { runs.push([season[a0], a0, t - 1]); a0 = t; }
  for (let i = 0; i < runs.length; i++) {
    const [si, a, b] = runs[i];
    if (a < WARMUP || b < from) continue;   // 워밍업 이후 + 표시 창(5년)과 겹치는 구간만
    const ongoing = i === runs.length - 1, exit = ongoing ? n - 1 : b + 1, p0 = P[a];
    let lo = p0, hi = p0; for (let t = a; t <= b; t++) { if (P[t] < lo) lo = P[t]; if (P[t] > hi) hi = P[t]; }
    const pct = x => +((x / p0 - 1) * 100).toFixed(2);
    out.push({ s: SEASONS[si], a: s.d[a], b: s.d[b], x: s.d[exit], days: b - a + 1, ongoing, from: i ? SEASONS[runs[i - 1][0]] : null,
      p0, ps0: +psOf(si, F[a], cal).toFixed(1), r: Object.fromEntries(HIST_N.map(N => [N, a + N < n ? pct(P[a + N]) : null])),
      rEnd: pct(P[exit]), mdd: pct(lo), mx: pct(hi) });
  }
  return out.reverse();
}
