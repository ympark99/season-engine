// 시장 지표 3종 — 우리 엔진으로 유니버스 전종목을 매일 판정한 결과에서 계산한다.
//   ① 시장 온도 (0 바닥 · 100 과열): 시장폭(봄+여름 비율)·60일선 위 비율·52주 고점 대비 평균 거리를
//      각각 지난 3년 안에서 백분위로 바꿔 평균. 낮을수록 바닥권, 높을수록 과열권.
//   ② 추세 점수 (0~100): 전종목 국면 점수(계절·확률·정배열·고점 거리) 평균 + 순노출(봄+여름 − 가을+겨울).
//   ③ 리스크 경보: 60일 동안 −8% 넘게 빠진 종목 비율이 지난 3년 중 몇 번째로 높은가(백분위). 섹터별로도 가을·겨울 비율이 가장 높은 곳을 표시.
import { SEASONS } from './engine.js';
import { trendScore } from './opinion.js';

const WIN = 750;                         // 백분위 기준 창 (약 3년)

function pctRank(arr, i, w = WIN) {      // arr[i] 가 직전 w 개 안에서 몇 % 위치인가
  const a = Math.max(0, i - w + 1); let lo = 0, n = 0;
  for (let k = a; k <= i; k++) { if (arr[k] == null) continue; n++; if (arr[k] < arr[i]) lo++; else if (arr[k] === arr[i]) lo += 0.5; }
  return n > 20 ? 100 * lo / n : null;
}

/** items: prepItem 결과 (season·ps·align·dd 배열 포함). sectors: {code: 섹터} */
export function marketIndicators(items, sectors = {}) {
  const set = new Set(); for (const x of items) for (const d of x.s.d) set.add(d);
  const axis = [...set].sort(), ptr = items.map(() => 0);
  const rows = [];
  for (const D of axis) {
    let n = 0, bull = 0, above = 0, ddSum = 0, p8 = 0, n60 = 0, tSum = 0, cnt = [0, 0, 0, 0];
    items.forEach((x, k) => {
      const d = x.s.d; let i = ptr[k]; while (i + 1 < d.length && d[i + 1] <= D) i++; ptr[k] = i;
      if (d[i] !== D || i < 252) return;
      const s = x.season[i], p = x.s.p;
      n++; cnt[s]++; if (s <= 1) bull++;
      if (p[i] > x.s.m60[i]) above++;
      ddSum += x.dd[i];
      if (i >= 60) { n60++; if (p[i] / p[i - 60] - 1 <= -0.08) p8++; }
      tSum += trendScore({ season: SEASONS[s], prob: x.ps[i], align: x.align[i], dd: x.dd[i], ps5: i >= 5 && x.season[i - 5] === s ? x.ps[i] - x.ps[i - 5] : null });
    });
    if (n < Math.max(20, items.length * 0.4)) continue;
    rows.push({ D, n, breadth: 100 * bull / n, above: 100 * above / n, dd: ddSum / n, p8: n60 ? 100 * p8 / n60 : null, trend: tSum / n, cnt: cnt.map(c => 100 * c / n) });
  }
  if (rows.length < 60) return null;
  const B = rows.map(r => r.breadth), A = rows.map(r => r.above), DD = rows.map(r => r.dd), P8 = rows.map(r => r.p8);
  const temp = rows.map((_, i) => { const xs = [pctRank(B, i), pctRank(A, i), pctRank(DD, i)].filter(v => v != null); return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null; });
  const risk = rows.map((_, i) => pctRank(P8, i));
  const L = rows.length - 1, r = rows[L];
  const zoneOf = v => (v == null ? '—' : v < 20 ? '바닥권' : v < 40 ? '저점권' : v < 60 ? '중립' : v < 80 ? '고점권' : '과열권');
  const riskLbl = v => (v == null ? '—' : v < 50 ? '안정' : v < 70 ? '보통' : v < 85 ? '주의' : '경고');
  const trendLbl = v => (v < 35 ? '약세' : v < 45 ? '약세 우위' : v < 55 ? '중립' : v < 65 ? '강세 우위' : '강세');
  const lo60 = Math.min(...temp.slice(Math.max(0, L - 60)).filter(v => v != null));
  // 섹터 경보 — 종목 4개 이상인 섹터 중 가을·겨울 비율이 가장 높은 곳
  const bySec = {};
  for (const x of items) {
    const sec = sectors[x.code]; if (!sec) continue;
    const i = x.s.d.length - 1; if (x.s.d[i] !== r.D) continue;
    const b = bySec[sec] || (bySec[sec] = { n: 0, weak: 0 }); b.n++; if (x.season[i] >= 2) b.weak++;
  }
  const secTop = Object.entries(bySec).filter(([, v]) => v.n >= 4).map(([k, v]) => ({ k, pct: Math.round(100 * v.weak / v.n), n: v.n })).sort((a, b) => b.pct - a.pct)[0] || null;
  const base = P8.slice(Math.max(0, L - WIN)).filter(v => v != null);
  return {
    asof: r.D, n: r.n,
    temp: { v: temp[L] == null ? null : +temp[L].toFixed(1), zone: zoneOf(temp[L]), d5: temp[L - 5] != null && temp[L] != null ? +(temp[L] - temp[L - 5]).toFixed(1) : null,
      fromLow: temp[L] != null && isFinite(lo60) ? +(temp[L] - lo60).toFixed(1) : null, breadth: +r.breadth.toFixed(1), above: +r.above.toFixed(1), dd: +r.dd.toFixed(1) },
    trend: { score: +r.trend.toFixed(1), label: trendLbl(r.trend), net: +(r.cnt[0] + r.cnt[1] - r.cnt[2] - r.cnt[3]).toFixed(1), summer: +r.cnt[1].toFixed(1), d5: +(r.trend - rows[L - 5].trend).toFixed(1) },
    risk: { pct: risk[L] == null ? null : Math.round(risk[L]), label: riskLbl(risk[L]), p8: r.p8 == null ? null : +r.p8.toFixed(1),
      base: base.length ? +(base.reduce((a, v) => a + v, 0) / base.length).toFixed(1) : null, sector: secTop },
    hist: rows.slice(-260).map((x, k) => { const i = rows.length - Math.min(260, rows.length) + k; return [x.D, temp[i] == null ? null : +temp[i].toFixed(1), +x.trend.toFixed(1), risk[i] == null ? null : Math.round(risk[i]), +x.breadth.toFixed(1)]; }),
  };
}
