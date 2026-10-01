// 계절의 '쓸모'를 재는 보조 지표 — 각 계절이 뜻하는 바가 실제 수익으로 이어지는지 (정확도 자체는 lib/truth.js).
//   봄   60일 안에 여름으로 올라갔나 (진입 각)
//   여름 20일 안에 +10% 를 찍었나 (단기 급등), 20일 초과수익
//   가을 이후 20일 하락·최대낙폭 (추세 훼손)
//   겨울 20일 수익률이 음수인가, 그리고 이후 3개월 횡보했나
// 기저(base)는 같은 표본의 전체 날짜 평균이라, '시장이 좋아서 오른 것'과 구분된다.
import { features, psOf, SEASONS } from './engine.js';
import { classifyOf } from './engine2.js';

const WARMUP = 60;

export function semantics(items, P, { cal = null, from = null, to = null, H = 20, HL = 60, goal = 0.10 } = {}) {
  const { idx, dates } = (() => { const set = new Set(); for (const it of items) for (const d of it.s.d) set.add(d);
    const ds = [...set].sort(); return { idx: new Map(ds.map((d, i) => [d, i])), dates: ds }; })();
  const D = dates.length, seasons = items.map(it => classifyOf(it.s, P));
  const inWin = d => (!from || d >= from) && (!to || d <= to);

  const msum = new Float64Array(D), mcnt = new Int32Array(D);          // 날짜별 시장 평균 20일 수익률
  for (let k = 0; k < items.length; k++) {
    const { s } = items[k], n = s.p.length;
    for (let t = WARMUP; t + H < n; t++) { if (!inWin(s.d[t])) continue; const j = idx.get(s.d[t]); msum[j] += s.p[t + H] / s.p[t] - 1; mcnt[j]++; }
  }
  const mean = Float64Array.from(msum, (v, j) => (mcnt[j] > 4 ? v / mcnt[j] : NaN));

  const cell = () => ({ n: 0, exc: 0, raw: 0, hit10: 0, mdd: 0, up: 0, next: 0, side: 0 });
  const ph = SEASONS.map(cell), base = cell();
  for (let k = 0; k < items.length; k++) {
    const { s } = items[k], season = seasons[k], n = s.p.length;
    for (let t = WARMUP; t + H < n; t++) {
      if (!inWin(s.d[t])) continue;
      const mu = mean[idx.get(s.d[t])];
      if (!isFinite(mu)) continue;
      const r = s.p[t + H] / s.p[t] - 1;
      let mx = -9, mn = 9;
      for (let u = t + 1; u <= t + H; u++) { const q = s.p[u] / s.p[t] - 1; if (q > mx) mx = q; if (q < mn) mn = q; }
      base.n++; base.raw += r; base.exc += r - mu; base.up += mx; base.mdd += mn; if (mx >= goal) base.hit10++;
      if (t === 0 || season[t] === season[t - 1]) continue;             // 아래는 '진입일'만
      const c = ph[season[t]];
      c.n++; c.raw += r; c.exc += r - mu; c.up += mx; c.mdd += mn; if (mx >= goal) c.hit10++;
      if (season[t] === 0) {                                           // 봄 → 60일 안에 여름?
        let ok = 0; for (let u = t + 1; u <= Math.min(n - 1, t + HL); u++) if (season[u] === 1) { ok = 1; break; }
        c.next += ok;
      }
      if (season[t] === 3 && t + 80 < n) {                             // 겨울 → 20~80일 횡보?
        let mx2 = -9; for (let u = t + 20; u <= t + 80; u++) mx2 = Math.max(mx2, s.p[u] / s.p[t + 20] - 1);
        c.side += mx2 < 0.10 ? 1 : 0;
      }
    }
  }
  const fin = (c, extra = {}) => ({ n: c.n, raw: c.n ? +(100 * c.raw / c.n).toFixed(2) : null, exc: c.n ? +(100 * c.exc / c.n).toFixed(2) : null,
    hit10: c.n ? +(100 * c.hit10 / c.n).toFixed(1) : null, up: c.n ? +(100 * c.up / c.n).toFixed(2) : null,
    mdd: c.n ? +(100 * c.mdd / c.n).toFixed(2) : null, ...extra });
  return {
    H, HL, goal, base: fin(base),
    봄: fin(ph[0], { toSummer: ph[0].n ? +(100 * ph[0].next / ph[0].n).toFixed(1) : null }),
    여름: fin(ph[1]), 가을: fin(ph[2]),
    겨울: fin(ph[3], { sideways: ph[3].n ? +(100 * ph[3].side / ph[3].n).toFixed(1) : null }),
  };
}
