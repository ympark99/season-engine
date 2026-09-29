// 예시 포트폴리오 — 엔진이 시킨 대로만 사고팔았으면 어때을지. 진입·청산은 모두 그날 종가.
// 전략 셋: 국면(추세추종) / 대장(가치·실적) / 국면+대장(교집합)
// 미래 정보를 쓰지 않도록: 국면은 그날까지의 봉만, 대장은 asOf(분기말+45일)가 지난 분기만 쓴다.
import { classifyOf } from './engine2.js';
import { SEASONS } from './engine.js';
import { metricsAt, rawScores } from './fundamentals.js';

export const STRATS = ['국면', '대장', '국면+대장'];
const W = { accel: 0.30, growth: 0.15, margin: 0.15, cash: 0.15, quality: 0.10, value: 0.10, risk: 0.05 };
const KEYS = Object.keys(W);

/** 배열 안에서 v 의 백분위 (0~100) */
function pctOf(v, sorted) {
  if (v == null || !sorted.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return 100 * lo / Math.max(1, sorted.length - 1);
}

/**
 * 시뮬레이션.
 * @param items   prep 결과 [{ code, name, s(Series) }]
 * @param P,cal   엔진 파라미터
 * @param fundRows { code: rows }  (미국 분기 재무. 없으면 대장 전략은 건너뜀)
 * @param opt     { hold: 보유 종목 수, everyN: 리밸런스 간격(거래일), years, cost: 왕복 비용%, start }
 */
export function simulate(items, P, cal, fundRows = {}, opt = {}) {
  const hold = opt.hold || 10, everyN = opt.everyN || 5, cost = (opt.cost ?? 0.3) / 100;
  const axisSet = new Set();
  const U = items.filter(it => it.s?.d?.length > 260);
  for (const it of U) for (const d of it.s.d) axisSet.add(d);
  let axis = [...axisSet].sort();
  const start = opt.start || axis[Math.max(0, axis.length - (opt.years ? opt.years * 252 : 756))];
  axis = axis.filter(d => d >= start);
  if (axis.length < 60) throw new Error('기간이 너무 짧아');

  const St = U.map(it => ({ it, season: classifyOf(it.s, P), ptr: 0 }));
  const fundCache = new Map();
  const fundRawAt = (code, date) => {                                  // 그 시점에 공시돼 있던 분기만으로 점수
    const rows = fundRows[code];
    if (!rows?.length) return null;
    const n = rows.filter(r => r.asOf && r.asOf <= date).length;
    const k = `${code}|${n}`;
    if (!fundCache.has(k)) { const m = metricsAt(rows, date); fundCache.set(k, m?.ok ? rawScores(m) : null); }
    return fundCache.get(k);
  };

  const books = Object.fromEntries(STRATS.map(k => [k, { pos: new Map(), closed: [], curve: [], eq: 100, peak: 100, mdd: 0 }]));
  const priceOf = x => x.it.s.p[x.ptr], dateOf = x => x.it.s.d[x.ptr];

  for (let t = 0; t < axis.length; t++) {
    const D = axis[t];
    for (const x of St) { const d = x.it.s.d; while (x.ptr + 1 < d.length && d[x.ptr + 1] <= D) x.ptr++; }
    const live = St.filter(x => dateOf(x) >= axis[Math.max(0, t - 5)] && priceOf(x) > 0);   // 5일 넘게 안 도는 종목 제외

    // 이 날짜 기준 대장 점수 (리밸런스 날만 계산)
    let fundPct = null;
    const isReb = t % everyN === 0;
    if (isReb && Object.keys(fundRows).length) {
      const raws = live.map(x => ({ x, r: fundRawAt(x.it.code, D) })).filter(o => o.r);
      if (raws.length >= 20) {
        const sorted = Object.fromEntries(KEYS.map(k => [k, raws.map(o => o.r[k]).filter(v => v != null).sort((a, b) => a - b)]));
        fundPct = new Map(raws.map(({ x, r }) => {
          let acc = 0, ws = 0;
          for (const k of KEYS) { const p = pctOf(r[k], sorted[k]); if (p != null) { acc += W[k] * p; ws += W[k]; } }
          return [x.it.code, ws ? acc / ws : null];
        }));
      }
    }

    for (const strat of STRATS) {
      const B = books[strat];
      if (strat !== '국면' && !Object.keys(fundRows).length) continue;                       // 대장 데이터가 없으면 그 전략은 건너뜀
      // 1) 평가 — 오늘 종가까지의 손익 (오늘 파는 종목도 오늘 종가로 판다)
      let day = 0;
      for (const [code, p] of B.pos) {
        const x = St.find(y => y.it.code === code); if (!x) continue;
        const px = priceOf(x); p.days++;
        if (p.prevMark) day += (px / p.prevMark - 1) / hold;
        p.prevMark = px;
      }
      // 2) 청산 — 조건이 깨지면 그날 종가에 판다
      for (const [code, p] of [...B.pos]) {
        const x = St.find(y => y.it.code === code); if (!x) continue;
        const sn = SEASONS[x.season[x.ptr]], px = priceOf(x);
        const fp = fundPct?.get(code) ?? p.lastFund ?? null;
        if (fp != null) p.lastFund = fp;
        let out = null;
        if (strat === '국면') { if (sn === '가을' || sn === '겨울') out = `${sn} 전환`; }
        else if (strat === '대장') { if (isReb && fp != null && fp < 45) out = '실적 점수 하락'; }
        else { if (sn === '겨울') out = '겨울 전환'; else if (isReb && fp != null && fp < 45 && (sn === '가을')) out = '가을 + 점수 하락'; }
        if (!out && px / p.entry - 1 < -0.15) out = '-15% 손절';
        if (out) {
          const ret = (px / p.entry - 1) - cost;
          B.closed.push({ code, name: x.it.name || code, in: p.date, out: D, entry: +p.entry.toFixed(2), exit: +px.toFixed(2), ret: +(100 * ret).toFixed(2), days: p.days, why: out });
          B.pos.delete(code); day -= (cost / 2) / hold;                 // 매도 비용
        }
      }
      // 3) 편입 — 리밸런스 날에만, 빈 자리만큼
      if (isReb && B.pos.size < hold) {
        const cands = [];
        for (const x of live) {
          if (B.pos.has(x.it.code)) continue;
          const sn = SEASONS[x.season[x.ptr]], fp = fundPct?.get(x.it.code) ?? null;
          const i = x.ptr, s = x.it.s, mom = i > 60 && s.p[i - 60] > 0 ? s.p[i] / s.p[i - 60] - 1 : 0;
          const fresh = x.season[Math.max(0, i - 20)] !== x.season[i];                     // 최근 20일 안에 바뀜 국면 우선
          if (strat === '국면') { if (sn === '여름' || (sn === '봄' && fresh)) cands.push({ x, k: mom + (sn === '여름' ? 0.2 : 0) }); }
          else if (strat === '대장') { if (fp != null && fp >= 70) cands.push({ x, k: fp / 100 }); }
          else { if (fp != null && fp >= 60 && (sn === '여름' || sn === '봄')) cands.push({ x, k: fp / 100 + mom }); }
        }
        cands.sort((a, b) => b.k - a.k);
        const room = hold - B.pos.size;
        for (const c of cands.slice(0, room)) {
          B.pos.set(c.x.it.code, { entry: priceOf(c.x), prevMark: priceOf(c.x), date: D, days: 0, lastFund: fundPct?.get(c.x.it.code) ?? null });
          day -= (cost / 2) / hold;                                    // 매수 비용
        }
      }
      B.eq *= 1 + day;
      B.peak = Math.max(B.peak, B.eq);
      B.mdd = Math.min(B.mdd, B.eq / B.peak - 1);
      if (t % 5 === 0 || t === axis.length - 1) B.curve.push([D, +B.eq.toFixed(2)]);
    }
  }

  // 마무리 — 보유 중인 것은 마지막 종가로 평가
  const last = axis[axis.length - 1];
  const out = {};
  for (const strat of STRATS) {
    const B = books[strat];
    const open = [...B.pos].map(([code, p]) => {
      const x = St.find(y => y.it.code === code);
      const px = x ? priceOf(x) : p.entry;
      return { code, name: x?.it.name || code, in: p.date, entry: +p.entry.toFixed(2), last: +px.toFixed(2), ret: +(100 * (px / p.entry - 1)).toFixed(2), days: p.days, season: x ? SEASONS[x.season[x.ptr]] : null };
    }).sort((a, b) => b.ret - a.ret);
    const cl = B.closed;
    const wins = cl.filter(c => c.ret > 0).length;
    const avg = cl.length ? cl.reduce((a, c) => a + c.ret, 0) / cl.length : null;
    const yrs = (Date.parse(last) - Date.parse(axis[0])) / (365.25 * 864e5);
    out[strat] = {
      stats: {
        cum: +(B.eq - 100).toFixed(2), cagr: yrs > 0.5 ? +(100 * ((B.eq / 100) ** (1 / yrs) - 1)).toFixed(2) : null,
        mdd: +(100 * B.mdd).toFixed(2), trades: cl.length, win: cl.length ? +(100 * wins / cl.length).toFixed(1) : null,
        avgRet: avg == null ? null : +avg.toFixed(2), avgDays: cl.length ? Math.round(cl.reduce((a, c) => a + c.days, 0) / cl.length) : null,
        hit10: cl.length ? +(100 * cl.filter(c => c.ret >= 10).length / cl.length).toFixed(1) : null,   // 목표(1~2개월 10%) 달성 비율
        open: open.length,
      },
      open, closed: cl.slice(-60).reverse(), curve: B.curve,
    };
  }
  return { from: axis[0], to: last, n: U.length, hold, everyN, cost: +(100 * cost).toFixed(2), strategies: out };
}

/** 기준선 — 표본 전체를 동일비중으로 계속 들고 있었을 때 */
export function buyHold(items, from) {
  const xs = items.filter(it => it.s?.d?.length > 260);
  if (!xs.length) return null;
  const rs = xs.map(it => { const i = it.s.d.findIndex(d => d >= from); return i < 0 ? null : it.s.p[it.s.p.length - 1] / it.s.p[i] - 1; }).filter(v => v != null && isFinite(v));
  return rs.length ? +(100 * rs.reduce((a, x) => a + x, 0) / rs.length).toFixed(2) : null;
}
