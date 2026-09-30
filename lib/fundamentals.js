// 펀더멘털(대장 엔진 재료) — 미국 분기 재무 12개(손익 IQ · 현금 CQ · 재무 BQ)를 받아 지표로 가공한다.
// 주소는 lib/sources.js.
// 컨센서스(선행 EPS)는 여기 없으므로, '이익 정점'은 실적 증가율의 변화(가속도)로 대신 잡는다.
// 실제 발표는 분기말보다 늦으므로 백테스트에서는 asOf(분기말+LAG_DAYS) 이후에만 그 분기를 쓴다.
import { US_STMT as FV, UA } from './sources.js';
export const LAG_DAYS = 45;                       // 분기말 → 공시까지 통상 지연 (백테스트 look-ahead 방지)

const num = v => {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '—' || s === '-') return null;
  const x = +s;
  return Number.isFinite(x) ? x : null;
};
const iso = s => {                                 // "6/30/2026" → "2026-06-30"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

export async function fetchStatement(ticker, s, { timeoutMs = 15000 } = {}) {
  const url = `${FV}?t=${encodeURIComponent(ticker)}&so=F&s=${s}`;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`미국 재무(${s}) HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.data?.Period) throw new Error(`미국 재무(${s}) 응답 형식이 달라`);
  return j;
}

/** 세 응답 → 분기 배열 (최신이 앞). 없는 항목은 null */
export function normalize({ IQ, CQ, BQ }) {
  const P = IQ?.data?.Period || CQ?.data?.Period || BQ?.data?.Period || [];
  const col = (src, key, i) => num(src?.data?.[key]?.[i]);
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const end = iso(IQ?.data?.['Period End Date']?.[i] || CQ?.data?.['Period End Date']?.[i] || BQ?.data?.['Period End Date']?.[i]);
    out.push({
      q: P[i], end, asOf: end ? addDays(end, LAG_DAYS) : null,
      rev: col(IQ, 'Total Revenue', i), gp: col(IQ, 'Gross Profit', i), rnd: col(IQ, 'Research and Development', i),
      opInc: col(IQ, 'Operating Income', i), ebitda: col(IQ, 'EBITDA', i), net: col(IQ, 'Net Income', i),
      eps: col(IQ, 'EPS (Diluted)', i) ?? col(IQ, 'EPS (Recurring)', i), epsRec: col(IQ, 'EPS (Recurring)', i),
      interest: col(IQ, 'Interest Expense', i), sbc: col(IQ, 'Stock Option Compensation Expense', i),
      shares: col(IQ, 'Shares Outstanding', i), mcap: col(IQ, 'Market Capitalization', i),
      gm: col(IQ, 'Gross Margin', i), om: col(IQ, 'Operating Margin', i), nm: col(IQ, 'Net Margin', i),
      ps: col(IQ, 'Price To Sales Ratio', i), pe: col(IQ, 'Price To Earnings Ratio', i),
      cfo: col(CQ, 'Cash from Operating Activities', i), capex: col(CQ, 'Capital Expenditures', i),
      fcf: col(CQ, 'Free Cash Flow', i), pfcf: col(CQ, 'Price to Free Cash Flow', i),
      debtNet: col(CQ, 'Issuance or Reduction of Debt, Net', i), equityIssue: col(CQ, 'Sale of Common Pref Stock', i),
      divPaid: col(CQ, 'Cash Dividends Paid', i),
      cash: col(BQ, 'Cash & Short Term Investments', i), ltd: col(BQ, 'Long Term Debt', i),
      std: col(BQ, 'Short Term Debt Incl. Current Port. of LT Debt', i), equity: col(BQ, 'Total Equity', i),
      assets: col(BQ, 'Total Assets', i), pb: col(BQ, 'Price to Book Ratio', i),
      roe: col(BQ, 'Return on Equity', i), roic: col(BQ, 'Return on Invested Capital', i),
    });
  }
  return out;
}

const sum4 = (rows, k, i) => {                     // i 분기부터 과거 4개 합 (하나라도 없으면 null)
  let s = 0;
  for (let j = i; j < i + 4; j++) { const v = rows[j]?.[k]; if (v == null) return null; s += v; }
  return s;
};
/** 증가율 — 기저가 0 근처면 값이 폭발하므로 floor(매출의 2% 등)로 나누고 ±300%로 자른다 */
const growth = (a, b, floor = 0) => {
  if (a == null || b == null) return null;
  const den = Math.max(Math.abs(b), floor);
  if (den < 1e-9) return null;
  return Math.max(-3, Math.min(3, (a - b) / den));
};
const zOf = (v, arr) => {
  const xs = arr.filter(x => x != null && isFinite(x));
  if (v == null || xs.length < 6) return null;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) || 1;
  return +((v - m) / sd).toFixed(2);
};

/**
 * 지표 계산. at = 기준 시점(YYYY-MM-DD). 그 시점에 공시돼 있던 분기만 사용한다.
 * 대장 엔진의 핵심은 '성장률의 변화(가속도)' — 정유처럼 이익 정점을 지나면 국면이 旺이어도 비중을 줄이는 근거.
 */
export function metricsAt(rows, at = null) {
  const avail = rows.filter(r => r.end && (!at || (r.asOf && r.asOf <= at)));
  if (avail.length < 8) return { ok: false, why: `분기 ${avail.length}개 (8개 필요)`, n: avail.length };
  const i = 0;                                      // avail 은 최신순
  const R = avail;
  const ttm = k => sum4(R, k, i), ttmPrev = k => sum4(R, k, i + 4), ttmPrev2 = k => sum4(R, k, i + 8);

  const cur0 = R[i];
  const rev = ttm('rev'), revP = ttmPrev('rev'), revP2 = ttmPrev2('rev');
  const ni = ttm('net'), niP = ttmPrev('net'), niP2 = ttmPrev2('net');
  const op = ttm('opInc'), opP = ttmPrev('opInc');
  const fcf = ttm('fcf'), fcfP = ttmPrev('fcf');
  const eps = ttm('eps'), epsP = ttmPrev('eps'), epsP2 = ttmPrev2('eps');

  const fNi = rev ? 0.02 * Math.abs(rev) : 0;                    // 순이익·EPS 증가율의 기저 하한 (매출의 2%)
  const fEps = cur0.shares ? fNi / cur0.shares : 0;
  const gRev = growth(rev, revP), gRevP = growth(revP, revP2);
  const gEps = growth(eps, epsP, fEps), gEpsP = growth(epsP, epsP2, fEps);
  const gNi = growth(ni, niP, fNi);

  const cur = cur0;
  const omTtm = rev ? 100 * op / rev : null, omPrev = revP ? 100 * opP / revP : null;
  const fcfM = rev ? 100 * fcf / rev : null, fcfMPrev = revP ? 100 * fcfP / revP : null;
  const ebitda = ttm('ebitda'), interest = ttm('interest');
  const debt = (cur.ltd ?? 0) + (cur.std ?? 0), netDebt = debt - (cur.cash ?? 0);
  const debtRaise = ttm('debtNet'), eqRaise = ttm('equityIssue');
  const dilution = growth(cur.shares, R[i + 4]?.shares);

  const m = {
    ok: true, q: cur.q, end: cur.end, asOf: cur.asOf, n: avail.length,
    rev, eps, ni, fcf, ebitda, mcap: cur.mcap, shares: cur.shares,
    gRev: gRev == null ? null : +(100 * gRev).toFixed(1),          // TTM 매출 YoY
    gEps: gEps == null ? null : +(100 * gEps).toFixed(1),          // TTM EPS YoY
    gNi: gNi == null ? null : +(100 * gNi).toFixed(1),
    accelRev: gRev != null && gRevP != null ? +(100 * (gRev - gRevP)).toFixed(1) : null,   // 성장률의 변화
    accelEps: gEps != null && gEpsP != null ? +(100 * (gEps - gEpsP)).toFixed(1) : null,   // ← 이익 정점 신호
    om: omTtm == null ? null : +omTtm.toFixed(1), dOm: omTtm != null && omPrev != null ? +(omTtm - omPrev).toFixed(1) : null,
    gm: cur.gm, fcfM: fcfM == null ? null : +fcfM.toFixed(1), dFcfM: fcfM != null && fcfMPrev != null ? +(fcfM - fcfMPrev).toFixed(1) : null,
    fcfPos: R.slice(i, i + 4).filter(r => (r.fcf ?? -1) > 0).length,                        // 최근 4분기 중 FCF 플러스 횟수
    netDebt: +netDebt.toFixed(1), debtRaise, eqRaise, dilution: dilution == null ? null : +(100 * dilution).toFixed(1),
    levEbitda: ebitda > 0 ? +(netDebt / ebitda).toFixed(2) : null,
    intCov: interest > 0 && ebitda != null ? +(ebitda / interest).toFixed(2) : null,
    roe: cur.roe, roic: cur.roic,
    noisy: !!(niP != null && rev && Math.abs(niP) < 0.02 * Math.abs(rev)),     // 기저가 작아 증가율 해석에 주의
    ps: cur.ps, pb: cur.pb, pfcf: cur.pfcf, pe: cur.pe,
    zPs: zOf(cur.ps, R.map(r => r.ps)), zPb: zOf(cur.pb, R.map(r => r.pb)), zPfcf: zOf(cur.pfcf, R.map(r => r.pfcf)),
  };
  // 투자 재원 — 9/28 리포트의 '내 돈 / 남의 돈' 구분을 자동 판정
  m.funding = fcf == null ? null
    : fcf > 0 && (debtRaise ?? 0) <= 0 ? '내 돈'
      : fcf > 0 ? '내 돈(일부 차입)'
        : (debtRaise ?? 0) > 0 || (eqRaise ?? 0) > 0 ? '남의 돈' : 'FCF 적자';
  return m;
}

/** 유니버스 백분위를 매기기 전의 원점수 — 부호만 맞춰둔 값들 */
export function rawScores(m) {
  if (!m?.ok) return null;
  return {
    accel: m.accelEps ?? m.accelRev ?? null,        // 성장 가속 (정점 통과면 음수)
    growth: m.gEps ?? m.gRev ?? null,
    margin: m.dOm,                                   // 마진 개선폭
    cash: m.dFcfM,                                   // FCF 마진 개선폭
    quality: m.roic,
    value: m.zPs == null ? null : -m.zPs,            // 자기 과거 대비 싸면 +
    risk: -(m.levEbitda ?? 0) - Math.max(0, m.dilution ?? 0) / 5,
  };
}
