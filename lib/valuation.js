// 밸류에이션 — 유형별 3시나리오 DCF · 역DCF · 민감도 · 안전마진 · (미국) PER·PBR 밴드.
// 계산은 전부 여기서 한다 (같은 재료·가정이면 늘 같은 값). Claude 정기 조사(경쟁·기술 갱신)는 가정 값과 근거만
// public/data/val/{m}_{code}.json 에 넣는다 — 형식은 public/data/val/README.md.
//
// 유형 (가정을 다르게 세운다)
//   cyc    경기민감 — 3~5년 차 마진이 사이클 중간값으로 돌아간다. 역DCF = 정점 마진이 몇 년 유지돼야 지금 주가인가
//   growth 고성장   — 10년. 성장률은 영구성장률까지 줄고, 마진은 성숙 마진까지 올라간다. 역DCF = 필요한 연 매출 성장률
//   mature 성숙     — 5년. 성장률만 서서히 줄고 마진 유지. 역DCF = 주가에 반영된 영구성장률
//   loss   적자     — DCF 부적합. 성숙 마진에 도달했다 치고 필요한 매출 규모만
//   na     금융·리츠·코인 — DCF 대상 아님 (밴드만)
// 금액 단위: 미국 백만 달러(주식 수도 백만 주), 국내 억원(주식 수는 주). 주당 가치 = 지분가치 × MUL ÷ 주식 수.
import { bandSelf, CYCLICAL } from './band.js';

export const VAL_REV = '2026-10-19b';
const NA = new Set(['은행·금융지주', '은행', '증권', '증권·운용', '보험', '리츠', '코인', '지주']);
const CYC = new Set([...CYCLICAL.filter(t => !NA.has(t)), '에너지', '소재']);
const MKT = { US: { rf: 0.042, erp: 0.05, g: 0.03, tax: 0.18, mul: 1 }, KR: { rf: 0.03, erp: 0.06, g: 0.025, tax: 0.22, mul: 1e8 } };
const W_SOFT = [0.08, 0.12], W_ASYM = [0.06, 0.18], CONV = { cyc: 0.6, growth: 0.5, mature: 0.8, loss: 0.6 };
const SM_MIN = 0.2, SM_MAX = 0.6, P0 = { bull: 25, base: 50, bear: 25 }, NAME = { bull: '낙관', base: '기본', bear: '비관' };
const clip = (x, a, b) => Math.max(a, Math.min(b, x));
const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const r1 = v => (v == null ? null : Math.round(v * 10) / 10), r3 = v => (v == null ? null : Math.round(v * 1000) / 1000);
const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const yrs = (end, today) => (Date.parse(end) - Date.parse(today)) / (365.25 * 864e5);
const addYear = (d, k = 1) => { const x = new Date(Date.parse(d)); x.setUTCFullYear(x.getUTCFullYear() + k); return x.toISOString().slice(0, 10); };
const endOf = (y, mo) => new Date(Date.UTC(y, mo || 12, 0)).toISOString().slice(0, 10);
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/** 재투자 수익률(RONIC) — 영구가치의 재투자율 g/RONIC 에 쓴다. 화면 슬라이더도 같은 규칙 (public/index.html valPv)
 *  prem 이 있으면 할인율 + prem (prem = 최근 ROIC 의 초과수익 절반, 0~5%p — 경쟁 우위가 확인된 만큼만 초과수익이 남는다), 없으면 예전 규칙 */
export const ronicOf = (w, prem = null) => (prem != null ? w + prem : Math.max(w + 0.02, 0.12));
/** 바꾼 규칙 (기본 켜짐) — 비교용으로 끌 수 있다: 국내 영구가치 재투자 연동 · g 상한(무위험금리, 할인율−2%p) · g 금리 연동 · ROIC 기반 RONIC · 성장주 마진 페이드 */
export const OPT_NEW = { krTV: true, gCap: true, gDyn: true, ronic: true, fade: true };
export const OPT_OLD = { krTV: false, gCap: false, gDyn: false, ronic: false, fade: false };
const G_GAP = 0.02;

/** 한 시나리오의 기업(지분)가치 — 명시 기간 FCF 현재가치 + 영구가치. S = {t[], fcf[], nopatT, conv?} (conv 가 있으면 국내 간이식) */
export function pvOf(S, w, g) {
  let v = 0;
  S.fcf.forEach((f, i) => { v += f / (1 + w) ** S.t[i]; });
  const base = S.conv != null ? S.nopatT * S.conv : S.nopatT * (1 - g / ronicOf(w, S.prem));
  const tv = (base * (1 + g)) / (w - g) / (1 + w) ** S.t[S.t.length - 1];
  return { v: v + tv, tv };
}

const regress = (xs, ys) => {
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let cov = 0, vr = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vr += (xs[i] - mx) ** 2; }
  return vr > 0 ? cov / vr : null;
};
const weekOf = d => { const t = Date.parse(d), day = new Date(t).getUTCDay() || 7; return new Date(t - (day - 1) * 864e5).toISOString().slice(0, 10); };
/**
 * 베타 — 3년 주간(그 주 마지막 종가) 수익률을 지수에 회귀. 일간은 단기 급등락 노이즈가 커서 주간을 기본으로 하고,
 * 상장이 짧아 52주가 안 되면 2년 일간으로 대신한다. → { b, basis, n } (못 구하면 null)
 */
export function betaOf(bars, ix) {
  if (!bars?.d?.length || !ix?.d?.length) return null;
  const last = x => { const m = new Map(); x.d.forEach((d, i) => { if (x.c[i] > 0) m.set(weekOf(d), x.c[i]); }); return m; };
  const A = last(bars), X = last(ix), ks = [...A.keys()].filter(k => X.has(k)).sort().slice(-157);
  if (ks.length >= 53) {
    const xs = [], ys = [];
    for (let i = 1; i < ks.length; i++) { ys.push(Math.log(A.get(ks[i]) / A.get(ks[i - 1]))); xs.push(Math.log(X.get(ks[i]) / X.get(ks[i - 1]))); }
    const b = regress(xs, ys);
    if (b != null) return { b, basis: ks.length >= 157 ? '3년 주간' : `${ks.length - 1}주 주간`, n: xs.length };
  }
  const pi = new Map(ix.d.map((d, i) => [d, ix.c[i]]));
  const xs = [], ys = [];
  let pd = null;
  for (let i = Math.max(0, bars.d.length - 504); i < bars.d.length; i++) {
    const d = bars.d[i], a = bars.c[i], b = pi.get(d);
    if (!(a > 0 && b > 0)) { pd = null; continue; }
    if (pd) { ys.push(Math.log(a / pd[0])); xs.push(Math.log(b / pd[1])); }
    pd = [a, b];
  }
  if (xs.length < 120) return null;
  const b = regress(xs, ys);
  return b == null ? null : { b, basis: '일간', n: xs.length };
}

const sum4 = (rows, k, i) => { let s = 0; for (let j = i; j < i + 4; j++) { const v = rows[j]?.[k]; if (v == null) return null; s += v; } return s; };

/** 미국 재료 — 분기 재무(최근이 앞) + 컨센서스(연간 3년). 금액 백만 달러 */
function baseUS(rec, est, px) {
  const R = (rec?.rows || []).filter(r => r.end);
  if (R.length < 4) return { why: `분기 재무 ${R.length}개 (4개 필요)` };
  const int4 = (() => { const xs = R.slice(0, 4).map(r => r.interest).filter(v => v > 0); return xs.length ? (xs.reduce((a, b) => a + b, 0) * 4) / xs.length : null; })();   // 최근 4분기 이자비용 (빈 분기는 평균으로 채움)
  const rev0 = sum4(R, 'rev', 0), op0 = sum4(R, 'opInc', 0), net0 = sum4(R, 'net', 0), eb0 = sum4(R, 'ebitda', 0), cx0 = sum4(R, 'capex', 0), eps0 = sum4(R, 'eps', 0);
  if (!(rev0 > 0)) return { why: '최근 4분기 매출 없음' };
  const omHist = [], sbcHist = [];
  for (let i = 0; i + 4 <= R.length; i++) { const r = sum4(R, 'rev', i), o = sum4(R, 'opInc', i); if (r > 0 && o != null) { omHist.push(o / r); sbcHist.push((sum4(R, 'sbc', i) ?? 0) / r); } }
  const cur = R[0];
  let shares = cur.shares > 0 ? cur.shares : null;
  if (cur.mcap > 0 && px > 0 && (!shares || Math.abs(cur.mcap / px / shares - 1) > 0.5)) shares = shares || cur.mcap / px;   // 주식 수 단위 이상하면 시총 ÷ 주가
  if (!(shares > 0)) return { why: '주식 수 없음' };
  const k0 = op0 > 0 && net0 != null ? net0 / op0 : null;
  const k = k0 != null && k0 >= 0.7 && k0 <= 1.05 ? k0 : 0.8;                        // 순이익 ÷ 영업이익 — 추정 EPS(조정)를 영업이익률로 되돌릴 때. 이자·일회성으로 튀면 0.8
  const tax = op0 > 0 && net0 > 0 ? clip(1 - net0 / op0, 0.1, 0.25) : MKT.US.tax;
  const debt = (cur.ltd ?? 0) + (cur.std ?? 0), cash = cur.cash ?? 0;
  const ys = (est?.y || []).filter(y => y.rev > 0 && y.end).sort((a, b) => a.end.localeCompare(b.end));
  const omE = (eps, rev) => (eps != null && rev > 0 ? clip((eps * shares) / rev / k, -0.5, 0.95) : null);
  const cons = ys.slice(0, 3).map(y => ({ fy: y.fy, end: y.end, rev: y.rev, om: omE(y.eps, y.rev),
    revHi: y.revHi ?? null, revLo: y.revLo ?? null, omHi: omE(y.epsHi, y.revHi ?? y.rev), omLo: omE(y.epsLo, y.revLo ?? y.rev), n: y.revN ?? y.epsN ?? null }));
  const roics = R.slice(0, 12).map(r => r.roic).filter(v => v != null && Number.isFinite(v));
  // 주식보상 — 추정 EPS(조정)는 주식보상을 빼고 잡는다. 매출의 3% 이상이고 컨센 마진이 회계 마진보다 그 절반 넘게 높으면 조정 기준으로 보고,
  //   과거 마진에 더해 같은 기준으로 맞춘 뒤 현금흐름에서 따로 뺀다(희석도 비용)
  const sbcR = (sum4(R, 'sbc', 0) ?? 0) / rev0, c0 = cons.find(c => c.om != null);
  const adj = sbcR >= 0.03 && c0 && c0.om - op0 / rev0 > sbcR / 2;
  return {
    m: 'US', ok: true, unit: '백만 달러', roic: roics.length >= 4 ? roics.reduce((a, b) => a + b, 0) / roics.length / 100 : null, roicBy: `최근 ${roics.length}분기 ROIC 평균`, rev0, om0: op0 / rev0 + (adj ? sbcR : 0), omGaap: op0 / rev0, omHist: adj ? omHist.map((o, i) => o + sbcHist[i]) : omHist, sbcR: adj ? sbcR : 0, shares, eps0, k, tax,
    capexR: cx0 != null ? Math.abs(cx0) / rev0 : 0.05, daR: eb0 != null && op0 != null ? Math.max(0, eb0 - op0) / rev0 : 0.04,
    debt, cash, netCash: cash - debt, int4, mcap: px > 0 ? px * shares : cur.mcap ?? null, equity: cur.equity ?? null,
    g0: (() => { const p = sum4(R, 'rev', 4); return p > 0 ? rev0 / p - 1 : null; })(),
    cons: cons.filter(c => c.om != null), asOf: cur.end, q: cur.q,
  };
}

/** 국내 재료 — 컨센서스 연간(실적 3년 + 추정 3년). 금액 억원. 순차입금 항목이 없어 지분 기준 간이식(영업이익 × (1−세율) × 현금 전환율) */
function baseKR(rec, px, sharesN) {
  const Y = (rec?.kr?.yearly || []).filter(r => r.y && r.rev > 0 && r.op != null);
  const act = Y.filter(r => !r.est), est = Y.filter(r => r.est);
  const last = act[act.length - 1];
  if (!last) return { why: '국내 연간 실적 없음' };
  let shares = sharesN > 0 ? sharesN : null;
  const np = last.npc ?? last.np;
  if (!shares && last.eps > 0 && np > 0) shares = (np * 1e8) / last.eps;
  if (!(shares > 0)) return { why: '주식 수 없음' };
  const today = kst();
  const cons = est.map(r => ({ fy: r.y, end: endOf(r.y, r.m), rev: r.rev, om: clip(r.op / r.rev, -0.5, 0.95), revHi: null, revLo: null, omHi: null, omLo: null }))
    .filter(c => c.end > today).slice(0, 3);
  const prev = act[act.length - 2];
  const roes = act.slice(-3).map(r => (r.equity > 0 && (r.npc ?? r.np) != null ? (r.npc ?? r.np) / r.equity : null)).filter(v => v != null);
  return {
    m: 'KR', ok: true, unit: '억원', roic: roes.length ? roes.reduce((a, b) => a + b, 0) / roes.length : null, roicBy: `최근 ${roes.length}년 ROE 평균 (국내는 ROIC 대신)`, rev0: last.rev, om0: last.op / last.rev, omHist: act.map(r => r.op / r.rev), shares, eps0: last.eps ?? null,
    k: last.op > 0 && np != null ? clip(np / last.op, 0.55, 1.05) : 0.75, tax: MKT.KR.tax, capexR: null, daR: null,
    debt: null, cash: null, netCash: 0, mcap: px > 0 ? (px * shares) / 1e8 : null, equity: last.equity ?? null,
    g0: prev?.rev > 0 ? last.rev / prev.rev - 1 : null, cons, asOf: endOf(last.y, last.m), q: last.p,
  };
}

/** 유형 — 조사 파일이 정했으면 그대로, 아니면 테마·재무로 */
/** 최근 4분기 매출 → 첫 컨센 해 성장률을 1년 기준으로 (회계연도 끝이 반년 뒤면 반년치 성장만 보이므로) */
const annG = (B, c1) => { const t = B.asOf ? clip(yrs(c1.end, B.asOf), 0.25, 2) : 1; return (c1.rev / B.rev0) ** (1 / t) - 1; };

export function typeOf(theme, B, R) {
  if (R?.type && ['cyc', 'growth', 'mature', 'loss', 'na'].includes(R.type)) return { type: R.type, by: '조사' };
  if (NA.has(theme)) return { type: 'na', by: '자동', why: `${theme} — 현금흐름 할인보다 자산·이익 배수로 보는 업종` };
  if (!B?.ok) return { type: 'na', by: '자동', why: B?.why || '재료 없음' };
  const c1 = B.cons[0];
  const per = B.m === 'KR' ? '최근 연간' : '최근 4분기';
  if (B.om0 <= 0 && !(c1 && c1.om > 0.05)) return { type: 'loss', by: '자동', why: `${per} 영업이익률 ${r1(100 * B.om0)}% — 아직 적자` };
  const span = B.omHist.length >= 4 ? Math.max(...B.omHist) - Math.min(...B.omHist) : 0;
  if (CYC.has(theme)) return { type: 'cyc', by: '자동', why: `${theme} — 경기민감 업종` };
  const g = c1 && B.rev0 > 0 ? annG(B, c1) : B.g0;
  if ((g ?? 0) >= 0.2) return { type: 'growth', by: '자동', why: `매출 성장 ${r1(100 * g)}% — 고성장` };   // 적자에서 막 벗어난 성장주를 경기민감으로 잘못 보지 않게 마진 변동보다 먼저
  if (span > 0.25) return { type: 'cyc', by: '자동', why: `영업이익률이 최근 ${B.omHist.length}개 시점 사이 ${r1(100 * span)}%p 움직임 — 경기민감으로 봄` };
  return { type: 'mature', by: '자동', why: '성장·마진이 안정적인 편' };
}

/** 소프트 캡 — 8~12% 는 그대로, 12% 위는 18% 에, 8% 아래는 6% 에 점점 가까워진다 (극단값은 막고 종목 간 위험 순서는 남긴다) */
export const softW = w => (w > W_SOFT[1] ? W_SOFT[1] + (W_ASYM[1] - W_SOFT[1]) * (1 - Math.exp(-(w - W_SOFT[1]) / (W_ASYM[1] - W_SOFT[1])))
  : w < W_SOFT[0] ? W_SOFT[0] - (W_SOFT[0] - W_ASYM[0]) * (1 - Math.exp(-(W_SOFT[0] - w) / (W_SOFT[0] - W_ASYM[0]))) : w);

/**
 * 할인율 — 무위험금리(10년물, 매일 갱신) + 보정 베타 × 위험프리미엄 = 자기자본비용, 부채 비중으로 가중평균.
 *   타인자본비용: 미국은 최근 4분기 이자비용 ÷ 차입금(무위험금리 ~ +6%p 로 자름), 없으면 무위험금리 + 1.5%p.
 *   국내는 차입금이 조사 파일에 있을 때만 부채를 반영한다(debt, 없고 순차입이면 순차입금을 차입금 하한으로).
 */
function waccOf(m, B, beta, rf) {
  const K = MKT[m], RF = rf?.v ?? K.rf, braw = beta?.b == null ? null : clip(beta.b, 0.3, 3.5);
  const badj = braw == null ? 1.2 : clip(0.67 * braw + 0.33, 0.6, 2.5);               // 평균(1) 쪽으로 당기는 보정
  const ke = RF + badj * K.erp;
  let wd = 0, kd = null, kdBy = null, w = ke;
  const debt = B.debtW ?? B.debt;
  if (debt > 0 && B.mcap > 0) {
    const eff = m === 'US' && B.int4 > 0 ? B.int4 / debt : null;
    const pre = eff != null ? clip(eff, RF, RF + 0.06) : B.kdR ?? RF + 0.015;
    kdBy = eff != null ? '유효 이자율' : B.kdR != null ? '조사' : '무위험금리 + 1.5%p';
    wd = debt / (debt + B.mcap); kd = pre * (1 - B.tax); w = (1 - wd) * ke + wd * kd;
  }
  return { w: r3(softW(w)), raw: r3(w), ke: r3(ke), rf: r3(RF), rfBy: rf?.v != null ? `${rf.src || '10년물'} ${rf.d || ''}`.trim() : '기본값', erp: K.erp,
    beta: braw == null ? null : r3(braw), betaBy: beta?.basis || null, badj: r3(badj), wd: r3(wd), kd: kd == null ? null : r3(kd), kdBy, est: braw == null };
}

/**
 * 영구 기간 초과수익(RONIC − 할인율). 같은 g 라도 RONIC 이 높으면 재투자(g/RONIC)가 적어 영구가치가 커진다 — 성장주·해자 프리미엄은 여기서 생긴다.
 *   ROIC = 과거 평균(미국 ROIC, 국내 ROE)과 예상 ROIC(기본 시나리오 첫해 — 경기민감은 마지막 해 — 세후 영업이익 ÷ 투하자본)를 반반 (한쪽만 있으면 그쪽)
 *   초과수익 = (ROIC − 할인율) ÷ 2 — 경쟁으로 절반은 사라진다고 봄. 상한 5%p (경기민감 3%p)
 *   하한: 고성장·적자(성장 단계) 2%p · 경쟁·기술 등급 S·A(해자 확인) 1%p · 그 외 0 (성숙·경쟁 심화 기업은 RONIC = 할인율로 수렴)
 */
function premOf(type, B, P, w, grade) {
  const ic = B.m === 'US'   // 투하자본 = 자본 + 순차입금
     ? (B.equity ?? 0) + (B.debt ?? 0) - (B.cash ?? 0) : (B.equity ?? 0) - (B.netCash ?? 0);
  const k = type === 'cyc' ? P.sc.base.rev.length - 1 : 0;                         // 경기민감은 정점 해가 아니라 중간값으로 돌아간 마지막 해 이익으로
  const n1 = P.sc.base.rev[k] * (P.sc.base.om[k] - sbcAt(B, k, P.sc.base.rev.length)) * (1 - B.tax);
  const fwd = ic > 0 && Number.isFinite(n1) ? clip(n1 / ic, -0.5, 1.5) : null;
  const xs = [B.roic, fwd].filter(v => v != null && Number.isFinite(v));
  const roic = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const growthy = type === 'growth' || type === 'loss', moat = grade === 'S' || grade === 'A';
  const floor = growthy ? 0.02 : moat ? 0.01 : 0, cap = type === 'cyc' ? 0.03 : 0.05;
  const prem = clip(roic == null ? floor : Math.max(floor, (roic - w) / 2), 0, Math.max(cap, floor));
  const why = `${roic == null ? 'ROIC 없음' : `ROIC ${r1(100 * roic)}% − 할인율 ${r1(100 * w)}%의 절반`}${floor ? ` · 하한 ${r1(100 * floor)}%p (${growthy ? '고성장' : `경쟁력 ${grade}`})` : ''} · 상한 ${r1(100 * cap)}%p`;
  return { prem, roic: roic == null ? null : r3(roic), fwd: fwd == null ? null : r3(fwd), why, by: `${B.m === 'US' ? '과거 ROIC' : '과거 ROE'}${fwd != null ? `·${type === 'cyc' ? '중간값 해' : '다음 해'} 예상 ROIC 평균` : ''}` };
}

const pct = v => (v == null ? null : num(v) / 100);
const arr = (a, i) => (Array.isArray(a) ? num(a[i]) : null);

/** 세 시나리오 경로 (매출·영업이익률·결산일) */
function pathsOf(B, type, R, gT, today, peerOm = null) {
  const H = type === 'growth' ? 10 : 5, C = B.cons;
  const L = C.length ? C[C.length - 1] : { rev: B.rev0, om: B.om0, end: today };
  const revL = L.rev, omL = L.om, ends = [];
  let e = C[0]?.end || addYear(today);
  for (let i = 0; i < H; i++) { ends.push(i < C.length ? C[i].end : e); e = addYear(i < C.length ? C[i].end : e); }
  const hist = B.omHist.filter(Number.isFinite);
  const peakH = hist.length ? Math.max(...hist, omL) : omL, troughH = hist.length ? Math.min(...hist) : omL * 0.5;
  // 사이클 중간값 · 성숙 마진 (조사 > 자동)
  let mid = pct(R?.mid?.om), midBy = mid != null ? '조사' : '자동', midWhy = R?.mid?.why || null;
  if (mid == null) {
    if (type === 'cyc') { const md = med(hist); mid = hist.length >= 8 && md != null ? clip(md, 0.05, omL) : omL * 0.5; midWhy = hist.length >= 8 ? `최근 ${hist.length}개 시점(분기별 직전 4분기) 영업이익률 중앙값${md < 0.05 ? ' (5% 아래라 5%로)' : ''}` : '기록이 짧아 지금 마진의 절반으로 둠'; }
    else if (type === 'growth' && peerOm != null && omL > peerOm) { mid = Math.max(omL - (omL - peerOm) / 2, 0.15); midWhy = `지금 마진 ${r1(100 * omL)}%에서 동종 업종 중앙값 ${r1(100 * peerOm)}% 쪽으로 절반 (성장이 둔화되면 경쟁으로 마진이 깎임)`; }
    else if (type === 'growth') { mid = Math.max(omL, 0.15); midWhy = omL >= 0.15 ? '지금 마진 유지' : '성숙 마진 15% (자동 가정)'; }
    else { mid = (omL + B.om0) / 2; midWhy = '최근 실적·컨센서스 마진 평균'; }
  }
  const trough = pct(R?.trough?.om) ?? Math.min(troughH, mid * 0.6);
  const sc = {};
  for (const k of ['bull', 'base', 'bear']) {
    const rev = [], om = [], src = [];
    const Rs = R?.scen?.[k] || {};
    const sgn = k === 'bull' ? 1 : k === 'bear' ? -1 : 0;
    const bump = type === 'cyc' ? [0.10, 0.04, 0.15, 0.08] : [0.05, 0.02, 0.08, 0.03];
    // 성장형 경로 준비
    const gL = clip(C.length >= 2 ? C[C.length - 1].rev / C[C.length - 2].rev - 1 : C.length === 1 && B.rev0 > 0 ? annG(B, C[0]) : B.g0 ?? gT, -0.1, type === 'growth' ? 0.6 : 0.15);
    const gS = type === 'growth' ? (gL > 0 ? gL * (k === 'bull' ? 1.3 : k === 'bear' ? 0.6 : 1) : gL + sgn * 0.03) : gL + (k === 'bull' ? 0.01 : k === 'bear' ? -0.02 : 0);
    const flatOm = type === 'mature' ? mid + (k === 'bull' ? 0.02 : k === 'bear' ? -0.03 : 0) : null;
    const nC = C.length, nRest = H - nC;
    let prevRev = B.rev0, omS = omL, revS = revL, tgt = null, cycT = null;
    const startAt = () => {                                                            // 컨센 뒤 첫 해 — 이 시나리오의 직전 해(조사로 덮은 값 포함)에서 출발
      omS = nC ? om[nC - 1] : B.om0; revS = nC ? rev[nC - 1] : B.rev0;
      tgt = type === 'growth' ? (k === 'bull' ? mid + 0.05 : k === 'bear' ? Math.max(mid - 0.05, omS - 0.1) : mid) : null;
      cycT = type === 'cyc' ? (k === 'base' ? mid : k === 'bull' ? (omS > mid ? (mid + omS) / 2 : mid + (peakH - mid) * 0.3) : mid * 0.8) : null;
    };
    for (let i = 0; i < H; i++) {
      let rv, o, s = '자동';
      if (i < nC) {
        const c = C[i]; s = '컨센';
        if (k === 'base') { rv = c.rev; o = c.om; }
        else if (k === 'bull') { rv = c.revHi ?? c.rev * (1 + bump[0]); o = c.omHi != null ? clip(c.omHi, c.om, c.om + 0.08) : c.om + bump[1]; }   // 최고 추정의 마진은 튀어서 +8%p 까지만
        else { rv = c.revLo ?? c.rev * (1 - bump[2]); o = c.omLo != null ? clip(c.omLo, c.om - 0.15, c.om) : c.om - bump[3]; }
      } else {
        const j = i - nC + 1, f = j / nRest;                                           // 컨센 이후 몇 번째 해 (1..nRest)
        if (j === 1) startAt();
        if (type === 'cyc') {
          if (k === 'bear' && omS > mid) o = j === 1 ? trough : trough + (cycT - trough) * ((j - 1) / Math.max(1, nRest - 1));   // 한 해 만에 바닥 → 회복
          else o = omS + (cycT - omS) * f;
          if (omS > mid + 0.02) { const a = k === 'bull' ? 0.7 : k === 'bear' ? 0.5 : 0.6; rv = revS * Math.max(0.4, a + (1 - a) * (omS > 0 ? o / omS : 1)); }
          else rv = prevRev * (1 + (k === 'bull' ? 0.10 : k === 'bear' ? 0.02 : 0.06));
        } else if (type === 'growth') {
          const fi = nC + j <= H ? (j - 1) / Math.max(1, nRest - 1) : 1;
          rv = prevRev * (1 + gS + (gT - gS) * fi);
          o = omS + (tgt - omS) * f;
        } else { const fi = (j - 1) / Math.max(1, nRest - 1); rv = prevRev * (1 + gS + (gT - gS) * fi); o = flatOm; }
      }
      const gR = arr(Rs.g, i), oR = arr(Rs.om, i);
      if (gR != null) { rv = prevRev * (1 + gR / 100); s = '조사'; }
      if (oR != null) { o = oR / 100; s = '조사'; }
      rv = Math.max(0, rv); o = clip(o, -0.6, 0.95);
      rev.push(rv); om.push(o); src.push(s); prevRev = rv;
    }
    sc[k] = { k, n: NAME[k], rev, om, src, why: Rs.why || null, p: num(Rs.p) ?? P0[k] };
  }
  const nC = C.length, omB = nC ? sc.base.om[nC - 1] : omL;                         // 역DCF 출발점도 조사로 덮은 기본 경로 기준
  return { sc, ends, H, mid, midBy, midWhy, trough, peakH, omL: omB, revL, nC };
}

/** i 번째 해 주식보상 비율 — 지금 비율에서 마지막 해 장기 비율(조사, 없으면 절반)로 */
const sbcAt = (B, i, n) => (B.sbcR ? B.sbcR + ((B.sbcL ?? B.sbcR / 2) - B.sbcR) * Math.min(1, i / Math.max(1, n - 1)) : 0);

/** 경로 → FCF 와 할인 연수 */
function cashOf(B, P, path, today, conv, tv = null) {
  const t = P.ends.map(e => Math.max(0.25, yrs(e, today)));
  for (let i = 1; i < t.length; i++) if (t[i] <= t[i - 1]) t[i] = t[i - 1] + 1;
  const fcf = path.rev.map((rv, i) => {
    const nopat = rv * (path.om[i] - sbcAt(B, i, path.rev.length)) * (1 - B.tax);
    const dWc = B.wcR ? B.wcR * (rv - (i ? path.rev[i - 1] : B.rev0)) : 0;               // 선수금 등 운전자본 — 매출 증가분 × 비율 (조사, 구독형은 +)
    return B.m === 'US' ? nopat + rv * (B.daR - B.capexR) + dWc : nopat * conv;
  });
  const nT = path.rev.length - 1, nopatT = path.rev[nT] * (path.om[nT] - sbcAt(B, nT, path.rev.length)) * (1 - B.tax);
  return { t: t.map(r3), fcf: fcf.map(r1), nopatT: r1(nopatT), ...(B.m === 'KR' && !tv?.krTV ? { conv } : {}), ...(tv?.prem != null ? { prem: r3(tv.prem) } : {}) };   // 영구가치: 국내도 재투자 연동(krTV)이면 conv 없이 미국과 같은 식
}

const perShare = (B, eqv) => Math.max(0, (eqv * MKT[B.m].mul) / B.shares);
const valOf = (B, S, w, g) => { const r = pvOf(S, w, g); return { px: perShare(B, r.v + B.netCash), tvPct: r.v > 0 ? Math.round((100 * Math.max(0, r.tv)) / r.v) : null, ev: r.v }; };
const bisect = (f, lo, hi, n = 50) => { for (let i = 0; i < n; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return (lo + hi) / 2; };

/** 역DCF — 유형마다 지금 주가를 맞추는 한 변수를 푼다 */
function reverseOf(type, B, P, px, w, g, today, conv, tv = null) {
  if (!(px > 0)) return null;
  const t0 = Math.max(0.25, yrs(P.ends[0], today));
  const mk = (rev, om) => cashOf(B, { ends: rev.map((_, i) => addYear(P.ends[0], i)) }, { rev, om }, today, conv, tv);
  const v = (rev, om) => valOf(B, mk(rev, om), w, g).px;
  if (type === 'cyc') {
    const base = P.sc.base, revP = Math.max(...base.rev.slice(0, Math.max(1, P.nC)), B.rev0), omP = Math.max(...base.om.slice(0, Math.max(1, P.nC)), B.om0);
    const revE = base.rev[base.rev.length - 1], omE = P.mid;
    const at = N => { const rev = [], om = []; for (let i = 0; i < N; i++) { rev.push(revP); om.push(omP); } for (let j = 1; j <= 3; j++) { rev.push(revP + (revE - revP) * j / 3); om.push(omP + (omE - omP) * j / 3); } return v(rev, om); };
    const atF = N => { const a = Math.floor(N), b = Math.ceil(N), va = at(a); return a === b ? va : va + (at(b) - va) * (N - a); };
    const lo = atF(0), hi = atF(15);
    const N = lo >= px ? 0 : hi < px ? null : bisect(x => atF(x) < px, 0, 15);
    return { kind: 'peakYears', val: N == null ? null : r1(N), over: hi < px, under: lo >= px, omP: r3(omP), revP: r1(revP), mid: r3(omE),
      txt: N == null ? `정점 마진 ${r1(100 * omP)}%가 15년 넘게 유지돼도 지금 주가가 안 나와` : N === 0 ? '마진이 바로 중간값으로 내려가도 지금 주가가 설명돼' : `정점 영업이익률(${r1(100 * omP)}%)이 ${r1(N)}년 유지된 뒤 3년에 걸쳐 중간값(${r1(100 * omE)}%)으로 내려와야 지금 주가야` };
  }
  if (type === 'growth') {
    const omL = P.omL, tgt = P.mid;
    const at = c => { const rev = [], om = []; let r = B.rev0; for (let i = 0; i < 10; i++) { r *= 1 + c; rev.push(r); om.push(omL + (tgt - omL) * (i + 1) / 10); } return v(rev, om); };
    const lo = at(-0.3), hi = at(1.0);
    const c = lo >= px ? -0.3 : hi < px ? null : bisect(x => at(x) < px, -0.3, 1.0);
    return { kind: 'cagr', val: c == null ? null : r3(c), over: hi < px, tgt: r3(tgt),
      txt: c == null ? '10년 동안 매년 100% 넘게 커야 지금 주가야' : `앞으로 10년 동안 매출이 연 ${r1(100 * c)}%씩 크고 영업이익률이 ${r1(100 * tgt)}%${tgt > omL + 0.005 ? '까지 올라가야' : tgt < omL - 0.005 ? '로 내려와도 버텨야' : '를 유지해야'} 지금 주가야` };
  }
  if (type === 'mature') {
    const S = cashOf(B, P, P.sc.base, today, conv, tv), hiG = w - (tv?.gGap ?? 0.005);
    const f = gg => valOf(B, S, w, gg).px;
    const lo = f(-0.05), hi = f(hiG);
    const gg = lo >= px ? -0.05 : hi < px ? null : bisect(x => f(x) < px, -0.05, hiG);
    return { kind: 'impliedG', val: gg == null ? null : r3(gg),
      txt: gg == null ? `영구성장률을 할인율 바로 아래(${r1(100 * hiG)}%)까지 올려도 지금 주가가 안 나와` : `지금 주가에는 영구성장률 ${r1(100 * gg)}%가 반영돼 있어 (기본 가정 ${r1(100 * g)}%)` };
  }
  if (type === 'loss') {
    const tgt = P.mid, need = px * B.shares / MKT[B.m].mul - B.netCash;              // 필요한 기업가치
    const fcfM = (tgt - sbcAt(B, 1, 1)) * (1 - B.tax) * (1 - g / ronicOf(w, tv?.prem));
    const req = fcfM > 0 ? (need * (w - g)) / (1 + g) / fcfM : null;
    const g1 = B.cons.length >= 2 ? B.cons[1].rev / B.cons[0].rev - 1 : B.g0;
    const yrsTo = req && g1 > 0 && req > B.rev0 ? Math.log(req / B.rev0) / Math.log(1 + g1) : null;
    return { kind: 'reqRev', val: req == null ? null : r1(req), x: req && B.rev0 > 0 ? r1(req / B.rev0) : null, yrs: yrsTo == null ? null : r1(yrsTo), tgt: r3(tgt),
      txt: req == null ? '성숙 마진을 정할 수 없어 계산 못 함' : `영업이익률 ${r1(100 * tgt)}%가 될 때 매출이 지금의 ${r1(req / B.rev0)}배여야 지금 주가야${yrsTo ? ` (지금 성장률이면 약 ${r1(yrsTo)}년)` : ''}` };
  }
  return null;
}

/** 미국 PER·PBR 밴드 — 분기말 배수(최근 분기 기록) 대비 지금 위치. 국내 밴드(lib/band.js bandStats)와 같은 모양 */
export function usBand(rec, px, theme) {
  const R = (rec?.rows || []).filter(r => r.end).slice().reverse();                   // 오래된 것부터
  if (R.length < 6) return null;
  const cur = rec.rows[0], sh = cur.shares;
  const eps4 = sum4(rec.rows, 'eps', 0), bvps = cur.equity > 0 && sh > 0 ? cur.equity / sh : null;
  const one = (key, now, ok) => {
    const hist = R.map(r => (ok(r[key]) ? r[key] : null)), vals = hist.filter(v => v != null).sort((a, b) => a - b);
    if (vals.length < 6) return null;
    const q = f => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
    const nowOk = now != null && ok(now);
    let lo = 0; while (lo < vals.length && vals[lo] < now) lo++;
    let hi = lo; while (hi < vals.length && vals[hi] === now) hi++;
    const r2 = x => (x == null ? null : +x.toFixed(2));
    return { now: r2(now), pct: nowOk ? Math.round((100 * ((lo + hi) / 2)) / vals.length) : null, n: vals.length, from: R[0].end, to: R[R.length - 1].end,
      min: r2(vals[0]), med: r2(q(0.5)), max: r2(vals[vals.length - 1]), p20: r2(q(0.2)), p80: r2(q(0.8)), loss: key === 'pe' && !(eps4 > 0),
      hist: hist.map(r2), hd: R.map(r => r.end), q: true };
  };
  const per = one('pe', eps4 > 0 && px > 0 ? px / eps4 : null, v => v != null && v > 0 && v <= 200);
  const pbr = one('pb', bvps > 0 && px > 0 ? px / bvps : null, v => v != null && v > 0);
  if (!per && !pbr) return null;
  return { per, pbr, self: bandSelf(per, pbr, CYC.has(theme) ? '메모리' : theme), at: rec.at, q: true };   // 경기민감은 PBR 중심 (bandSelf 가 CYCLICAL 목록으로 판단)
}

/**
 * 전체 계산.
 * @param m 'US'|'KR'  @param rec 펀더멘털 기록(fund:m:code)  @param est 미국 컨센서스 행 (est:US rows[code])
 * @param px 종가  @param theme 섹터  @param R 조사 가정 (public/data/val 파일, 없으면 null)
 * @param beta 2년 일봉 베타  @param sharesN 국내 상장주식수 (mcap:KR)
 */
export function valuate({ m, rec, est, px, theme, R = null, beta = null, sharesN = null, rf = null, peerOm = null, grade = null, opt = OPT_NEW, today = kst(), lite = false }) {
  if (typeof beta === 'number') beta = { b: beta, basis: '일간' };
  const B = m === 'US' ? baseUS(rec, est, px) : baseKR(rec, px, sharesN);
  const T = typeOf(theme, B, R);
  const out = { rev: VAL_REV, m, at: new Date().toISOString(), d: today, px: px ?? null, type: T.type, typeBy: T.by, typeWhy: R?.typeWhy || T.why || null,
    research: R ? { at: R.at || null, basis: R.basis || null } : null, notes: [] };
  if (!B?.ok || T.type === 'na') { out.why = T.type === 'na' ? (T.why || 'DCF 대상 아님') : B?.why; return out; }
  if (R?.tax != null) B.tax = clip(num(R.tax) / 100, 0, 0.4);
  if (num(R?.netCash) != null) { B.netCash = num(R.netCash); B.netBy = '조사'; }        // 국내는 재무 항목이 없어 조사로 넣는다 (단위: 미국 백만 달러, 국내 억원)
  if (m === 'KR') {                                                                  // 국내 부채 비중 — 조사 차입금, 없고 순차입이면 순차입금을 하한으로
    const d = num(R?.debt);
    B.debtW = d != null && d > 0 ? d : B.netBy === '조사' && B.netCash < 0 ? -B.netCash : null;
    B.debtBy = d != null && d > 0 ? '조사 차입금' : B.debtW ? '순차입금(하한)' : null;
  }
  if (num(R?.kd) != null) B.kdR = clip(num(R.kd) / 100, 0, 0.2);
  if (m === 'US' && R?.capexR != null) B.capexR = clip(num(R.capexR) / 100, 0, 0.8);
  if (m === 'US' && R?.daR != null) B.daR = clip(num(R.daR) / 100, 0, 0.5);
  if (m === 'US' && R?.wc != null) B.wcR = clip(num(R.wc) / 100, -1, 1.5);
  if (m === 'US' && B.sbcR && R?.sbc != null) B.sbcL = clip(num(R.sbc) / 100, 0, B.sbcR);   // 장기 주식보상 비율 (조사)
  const conv = m === 'KR' ? (R?.conv != null ? clip(num(R.conv) / 100, 0.1, 1.2) : CONV[T.type]) : undefined;
  const WC = waccOf(m, B, beta, rf);
  const w = R?.wacc != null ? clip(num(R.wacc) / 100, W_ASYM[0], W_ASYM[1]) : WC.w;
  // 영구성장률 — 기본값은 최근 3년 평균 10년물 − 1.5%p (1.5~3%), 경기민감 −0.5%p. 상한은 무위험금리와 할인율 − 2%p
  const gAvg = opt.gDyn && rf?.avg3 != null ? clip(rf.avg3 - 0.015, 0.015, 0.03) : null;
  const gBase = (gAvg ?? MKT[m].g) - (T.type === 'cyc' ? 0.005 : 0);
  let gT = R?.g != null ? clip(num(R.g) / 100, 0, 0.045) : gBase, gWhy = R?.g != null ? '조사' : gAvg != null ? `3년 평균 10년물 ${r1(100 * rf.avg3)}% − 1.5%p${T.type === 'cyc' ? ', 경기민감 −0.5%p' : ''}` : `기본${T.type === 'cyc' ? ', 경기민감 −0.5%p' : ''}`;
  if (opt.gCap) { const cap = Math.min(rf?.v ?? MKT[m].rf, w - G_GAP); if (gT > cap) { gT = Math.max(0, cap); gWhy += ` → 상한 ${r1(100 * gT)}%`; } }
  const P = pathsOf(B, T.type === 'loss' ? 'growth' : T.type, R, gT, today, opt.fade ? peerOm : null);
  const RO = opt.ronic ? premOf(T.type, B, P, w, grade) : null, prem = RO?.prem ?? null;
  const tv = { krTV: opt.krTV, prem, gGap: opt.gCap ? G_GAP : 0.005 };
  if (T.type === 'loss') P.mid = pct(R?.mid?.om) ?? Math.max(0.15, P.mid);
  const S = {}, V = {};
  for (const k of ['bull', 'base', 'bear']) { S[k] = cashOf(B, P, P.sc[k], today, conv, tv); V[k] = valOf(B, S[k], w, gT); }
  const rv = reverseOf(T.type, B, P, px, w, gT, today, conv, tv);
  Object.assign(out, { w: r3(w), g: r3(gT), rv });
  if (T.type === 'loss') {                                                             // 적자 — 시나리오 가치는 참고로만, 결론은 역DCF
    out.why = '적자 기업이라 DCF 적정가는 가정에 너무 민감해서 내지 않아 — 성숙 마진에 도달했다 치고 필요한 매출 규모만 봐';
    out.loss = true;
  } else {
    const pw = (P.sc.bull.p + P.sc.base.p + P.sc.bear.p) || 100;
    const wv = (V.bull.px * P.sc.bull.p + V.base.px * P.sc.base.p + V.bear.px * P.sc.bear.p) / pw;
    const sm = clip(V.base.px > 0 ? Math.max(SM_MIN, (V.base.px - V.bear.px) / V.base.px) : SM_MIN, SM_MIN, SM_MAX);
    Object.assign(out, { base: r1(V.base.px), bull: r1(V.bull.px), bear: r1(V.bear.px), wv: r1(wv), sm: r3(sm), buy: r1(V.base.px * (1 - sm)),
      gap: px > 0 && V.base.px > 0 ? r1(100 * (px / V.base.px - 1)) : null });
  }
  if (lite) return out;
  const ws = [-0.02, -0.01, 0, 0.01, 0.02].map(x => r3(clip(w + x, 0.05, 0.2))), gs = [-0.01, -0.005, 0, 0.005].map(x => r3(clip(gT + x, -0.01, 0.05)));
  const gap = opt.gCap ? G_GAP : 0.01;
  out.sens = T.type === 'loss' ? null : { ws, gs, gap, v: ws.map(ww => gs.map(gg => (ww - gg < gap - 1e-9 ? null : r1(valOf(B, S.base, ww, gg).px)))) };
  out.sc = Object.fromEntries(['bull', 'base', 'bear'].map(k => [k, { n: NAME[k], p: P.sc[k].p, why: P.sc[k].why, v: r1(V[k].px), tvPct: V[k].tvPct,
    rows: P.ends.map((e, i) => ({ e, rev: r1(P.sc[k].rev[i]), om: r3(P.sc[k].om[i]), fcf: S[k].fcf[i], src: P.sc[k].src[i] })), ...S[k] }]));
  out.inp = { unit: B.unit, mul: MKT[m].mul, shares: B.shares, netCash: r1(B.netCash), netBy: B.netBy || (m === 'US' ? '재무' : null), tax: r3(B.tax), capexR: B.capexR == null ? null : r3(B.capexR), daR: B.daR == null ? null : r3(B.daR), conv: conv ?? null,
    rev0: r1(B.rev0), om0: r3(B.om0), asOf: B.asOf, q: B.q, nC: P.nC, H: P.H, mid: r3(P.mid), midBy: P.midBy, midWhy: P.midWhy, trough: r3(P.trough), peakH: r3(P.peakH),
    omHistN: B.omHist.length, omGaap: B.omGaap == null ? null : r3(B.omGaap), wc: B.wcR ? r3(B.wcR) : null, sbc: B.sbcR ? { r0: r3(B.sbcR), rL: r3(B.sbcL ?? B.sbcR / 2), by: B.sbcL != null ? '조사' : '자동(절반)' } : null, gWhy, gGap: gap, roic: RO?.roic ?? (B.roic == null ? null : r3(B.roic)), roicBy: RO?.by || B.roicBy || null, roicPast: B.roic == null ? null : r3(B.roic), roicFwd: RO?.fwd ?? null, prem: prem == null ? null : r3(prem), premWhy: RO?.why || null, ronic: r3(ronicOf(w, prem)), krTV: !!opt.krTV, wacc: { ...WC, used: w, by: R?.wacc != null ? '조사' : '계산', debtBy: B.debtBy || (m === 'US' && B.debt > 0 ? '재무' : null) }, gBy: R?.g != null ? '조사' : '기본', peakYears: num(R?.peak?.years), peakWhy: R?.peak?.why || null };
  if (m === 'KR') out.notes.push(B.netBy === '조사'
    ? `국내: 세후 영업이익 × 현금 전환율을 할인율로 할인한 기업가치 + 조사한 순현금${B.debtW ? ` · 부채 비중은 ${B.debtBy} 기준` : ''}`
    : '국내: 순차입금 조사 전이라 기업가치에서 빼지 못했고 할인율도 자기자본비용 그대로야 — 차입이 많으면 과대평가, 현금이 많으면 과소평가될 수 있어');
  if (B.omHist.length < 8 && T.type === 'cyc' && P.midBy !== '조사') out.notes.push(`과거 마진 기록이 ${B.omHist.length}개 시점뿐이라 사이클 중간값은 조사 가정이 더 정확해`);
  if (B.sbcR) out.notes.push(`컨센서스 마진은 주식보상(매출의 ${r1(100 * B.sbcR)}%)을 뺀 조정 기준이라, 현금흐름에서 주식보상을 비용으로 따로 뺐어 (마지막 해 ${r1(100 * (B.sbcL ?? B.sbcR / 2))}%까지 줄어든다고 봄)`);
  if (WC.est) out.notes.push('일봉이 짧아 베타를 못 구해 1.2로 둠');
  if (Math.abs(WC.raw - WC.w) >= 0.0005) out.notes.push(`계산한 할인율 ${r1(100 * WC.raw)}% → 소프트 캡 ${r1(100 * WC.w)}% (12% 위는 18%에, 8% 아래는 6%에 점점 가까워짐)`);
  return out;
}

/* ---------- 조사 가정 (public/data/val) ---------- */
const VAL_RAW = process.env.VAL_REPO_URL || 'https://raw.githubusercontent.com/ympark99/season-engine/main/public/data/val/';   // '../intel/' 도 이 기준
const CACHE = new Map(), TTL = 15 * 60e3;
async function getJson(name) {
  const hit = CACHE.get(name);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null;
  try {
    if (process.env.VAL_DIR) { const fs = await import('node:fs'); const f = `${process.env.VAL_DIR}/${name}`; v = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
    else { const r = await fetch(new URL(name, VAL_RAW), { signal: AbortSignal.timeout(8000) }); v = r.ok ? await r.json() : null; }
  } catch { v = null; }
  CACHE.set(name, { t: Date.now(), v });
  return v;
}
export const valIndex = () => getJson('index.json');
/** 경쟁·기술 종합 등급 (public/data/intel/index.json) — 해자 확인용 */
export const intelIndex = () => getJson('../intel/index.json');
/** 한 종목 조사 가정 — 목록(index.json)에 있을 때만 받는다 */
export async function researchOf(m, code, idx = null) {
  const I = idx || (await valIndex());
  if (!I?.[`${m}:${code}`]) return null;
  return getJson(`${m}_${code}.json`);
}
