// 전략실 — 7개 전략 × 미국·한국. 전략마다 초기자본 1,000만원. 장부를 처음 만든 거래일부터 시작한다 (과거 재현 없음).
//   1호 상위점수   베스트 종목(추세+저점 90+ 또는 종합 90+)만 — 종합 90·계절 잘 맞음 → 추세 90·잘 맞음 → 종합 90 → 추세 90 순
//   2호 추세+가치  종합 점수(추세+저점 70 : 가치 30) 높은 순
//   3호 가치투자   대장 점수(실적·성장·마진·밸류) — 수익 목표 없음
//   4호 여름풀매수 계절 잘 맞음 + 여름 전환 종목 — 시가총액으로 비중, 목표 수익 도달 시 익절
//   5호 봄확정     계절 잘 맞음 + 봄 확정 종목 중 추세+저점 높은 순
//   6호 저점매수   겨울 20일+ · 20일선 대비 −15% 이하 매수 → 60일선 회복 · 40거래일
//   7호 눌림매매   급등 기준봉 뒤 눌림목 진입 (lib/pullback.js)
//
// 공통 규칙 (LAB_V 3 — 2026-10-15 개정, 이날부터 다시 시작)
//   - 목표: 3개월(63거래일)에 +30% (가치투자 제외). 계좌 손실 한도: 최근 3개월 고점 대비 −20% → 전량 현금 + 20거래일 쉼.
//   - 종목 0~5개. 주식 비중 상한 = 장세(강세 100%·중립 70%·약세 40%) × 매크로 위험도 가감 × 목표 진행(3개월 +30% 달성 → 절반으로 이익 보호, −10% 이하 → 60%).
//     종목 수 = 상한 × 5 (올림).
//   - 종목 비중 = 시가총액 등급 상한(100조↑ 35% · 10조↑ 30% · 2조↑ 22% · 그 밖 15%) × 매력도(60~100%). 한 거래 손실이 계좌의 15%를 넘지 않게
//     비중 ≤ 15% ÷ 손절폭.
//   - 매도: 전략별 손절 · +15% 절반 익절 · +30% 전량 익절(목표) · 3개월 보유하고 +5% 못 넘으면 시간 청산 · 전략별 신호.
//   - 체결은 신호가 나온 날 종가. 수수료·세금: 미국 매수·매도 각 0.1%, 국내 매수 0.05%·매도 0.25%. 소수점 주식 허용.
//   - 미국 전략도 원화 1,000만원으로 표시하지만 환율 변동은 넣지 않았다 (달러 수익률을 그대로 적용).
//   - 매일 그날의 실시간 국면·점수로 판단해서 장부에 기록하고, 한 번 기록된 날은 다시 계산하지 않는다.
import { SEASONS, features, psOf } from './engine.js';
import { classifyOf, dipOf, springConfirm } from './engine2.js';
import { trendScore, opinion } from './opinion.js';
import { targetOf } from './pullback.js';

export const CAPITAL = 10_000_000;
const FEE = { US: { buy: 0.001, sell: 0.001 }, KR: { buy: 0.0005, sell: 0.0025 } };
const MAX = 5, MIN_HOLD = 3, COOL = 5, MIN_TRADE = 0.03;
export const LAB_V = 3;                                                     // 규칙 버전 — 바뀌면 장부를 지우고 그날부터 다시
export const GOAL = { ret: 30, days: 63, loss: -20, halt: 20, tp1: 15, tp2: 30, time: 63, timeMin: 5, tradeLoss: 0.15 };

const COMMON = ['종목 0~5개 · 주식 비중 상한 = 장세 × 매크로 × 목표 진행 (3개월 +30% 달성 시 절반, −10% 이하면 60%) · 종목 수 = 상한 × 5',
  '비중 = 시가총액 등급 상한(100조↑ 35%·10조↑ 30%·2조↑ 22%·그 밖 15%) × 매력도 60~100% · 한 거래 손실 ≤ 계좌 15% (비중 ≤ 15% ÷ 손절폭)',
  '계좌 손실 한도: 최근 3개월 고점 대비 −20% → 전량 현금, 20거래일 쉼'];
const TPTXT = '익절: +15% 절반 · +30% 전량(3개월 목표) · 3개월 보유하고 +5% 미만이면 시간 청산';
export const STRATS = [
  { id: 'S1', no: 1, name: '상위점수', tag: '베스트 종목', tp: true, stopPct: -10,
    desc: '대시보드 베스트 종목(추세+저점 90점 이상 또는 종합 90점 이상)에서만 산다. 종합 90·계절 잘 맞음 → 추세 90·계절 잘 맞음 → 종합 90 → 추세 90 순서로 편입.',
    criteria: ['편입 순서: ① 종합 90+ & 계절 잘 맞음 ② 추세+저점 90+ & 계절 잘 맞음 ③ 종합 90+ ④ 추세+저점 90+ — 같은 순위 안에서는 점수 높은 순',
      '편출: 추세·종합 둘 다 75 미만(상위권 이탈) · 겨울 전환 → 전량 · 가을 전환 → 절반 · 손절 −10%', TPTXT, ...COMMON] },
  { id: 'S2', no: 2, name: '추세+가치', tag: '종합 점수', tp: true, stopPct: -10,
    desc: '종합 점수(추세+저점 70% + 가치 30%) 높은 종목부터 산다. 봄·여름 종목만.',
    criteria: ['편입: 봄·여름 + 종합 75 이상 — 종합 점수 높은 순', '편출: 종합 60 미만 · 겨울 전환 → 전량 · 가을 전환 → 절반 · 손절 −10%', TPTXT, ...COMMON] },
  { id: 'S3', no: 3, name: '가치투자', tag: '대장 점수', tp: false, stopPct: -20,
    desc: '대장 엔진(실적 가속·성장·마진·현금·질·밸류·위험)만으로 고른다. 실적이 좋아지는데 아직 비싸지 않은 종목. 수익 목표·익절 없이 점수로만 사고판다.',
    criteria: ['편입: 대장 점수 70 이상 + 싼 정도 백분위 35 이상 + 이익 정점 경계 아님 — 매력도(대장 80% + 싼 정도 20%) 높은 순',
      '편출: 대장 점수 50 미만 · 이익 정점 경계 · 손절 −20% (익절·시간 청산 없음)', ...COMMON.slice(0, 2), '계좌 손실 한도: 최근 3개월 고점 대비 −20% → 전량 현금, 20거래일 쉼 (수익 목표는 적용 안 함)'] },
  { id: 'S4', no: 4, name: '여름풀매수', tag: '잘 맞음 + 여름 전환', tp: true, stopPct: -10, tp1Off: true,
    desc: '계절 잘 맞음 종목이 여름으로 전환되면 산다. 시가총액이 클수록 비중을 크게 두고, 3개월 목표 수익(+30%)에 닿으면 전량 익절.',
    criteria: ['편입: 계절 잘 맞음 + 여름 전환 5거래일 이내 — 추세+저점 높은 순', '익절: +30% 전량 (목표 수익) · 3개월 보유하고 +5% 미만이면 시간 청산',
      '편출: 가을 전환 → 절반 · 겨울 전환 → 전량 · 손절 −10%', ...COMMON] },
  { id: 'S5', no: 5, name: '봄확정', tag: '잘 맞음 + 봄 확정', tp: true, stopPct: -10,
    desc: '계절 잘 맞음 + 봄 확정(반등 후 눌림 → 반등 고점 재돌파) 종목 중 추세+저점이 가장 높은 종목부터 산다. 봄 확정이 풀리거나 가을·겨울이면 판다.',
    criteria: ['편입: 계절 잘 맞음 + 봄 확정 — 추세+저점 높은 순', '편출: 가을·겨울 전환 · 봄 확정이 풀림 → 전량 · 여름이 되면 계속 보유 · 손절 −10%', TPTXT, ...COMMON] },
  { id: 'S6', no: 6, name: '저점매수', tag: '겨울 반등', tp: true, stopPct: -15,
    desc: '겨울이 충분히 이어진 뒤 깊게 빠진 종목을 사서 60일선까지의 반등을 먹고 나온다.',
    criteria: ['편입: 겨울 20거래일 이상 + 종가가 20일선 대비 −15% 이하 — 더 깊게 빠진 종목부터',
      '편출: 종가 60일선 회복 → 전량 · 보유 40거래일 → 시간 청산 · 손절 −15%', TPTXT, ...COMMON] },
  { id: 'S7', no: 7, name: '눌림매매', tag: '급등 뒤 눌림목', tp: true, stopPct: -8,
    desc: '거래량을 동반한 급등(기준봉) 뒤 거래량이 마르며 10일선 근처까지 눌린 날 산다. 그날 후보가 여럿이면 손익비가 가장 좋은 한 종목만.',
    criteria: ['기준봉: 5·10·20일선 정배열 + 종가 5일선 위 · 거래량 20일 평균 2배↑ · 종가 +3%↑ · 시가총액 3,000억↑',
      '눌림 진입: 기준봉 뒤 15거래일 안 · 고점 대비 −3~−15% · 10일선 ×1.03 이하 · 20일선·기준봉 시작가 위 · 거래량 마름 · 20일선 상승 — 손익비 1위 1종목/일',
      '손절: 기준봉 시작가와 진입가 −8% 중 높은 값 종가 이탈 · 익절: 봄·여름 진입은 가을·겨울 전환, 가을·겨울 진입은 다음 베이스라인 도달', TPTXT, ...COMMON] },
];

/* ------------------------------ 데이터 준비 ------------------------------ */

/** 종목별 시계열 계산 (판정·확률·정배열·고점거리·거래량·상대강도용 수익률) */
export function prepItem(it, P, cal) {
  const s = it.s, n = s.p.length, season = classifyOf(s, P), { F } = features(s, season), { cf } = springConfirm(s, P, season);
  const ps = new Float32Array(n), align = new Float32Array(n), dd = new Float32Array(n), runA = new Int32Array(n), vr1 = new Float32Array(n), vr5 = new Float32Array(n);
  const dq = [];
  let v20 = 0, v5 = 0;
  for (let t = 0; t < n; t++) {
    ps[t] = psOf(season[t], F[t], cal); align[t] = F[t][0];
    while (dq.length && dq[0] < t - 251) dq.shift();
    while (dq.length && s.p[dq[dq.length - 1]] <= s.p[t]) dq.pop();
    dq.push(t); dd[t] = 100 * (s.p[t] / s.p[dq[0]] - 1);
    runA[t] = t > 0 && season[t] === season[t - 1] ? runA[t - 1] : t;
    const v = s.v[t] || 0; v20 += v; v5 += v; if (t >= 20) v20 -= s.v[t - 20] || 0; if (t >= 5) v5 -= s.v[t - 5] || 0;
    const m20 = v20 / Math.min(t + 1, 20), m5 = v5 / Math.min(t + 1, 5);
    vr1[t] = m20 > 0 ? v / m20 : 1; vr5[t] = m20 > 0 ? m5 / m20 : 1;
  }
  return { ...it, season, cf, ps, align, dd, runA, vr1, vr5 };
}

/** 장세 점수 */
const IDXV = [0.5, 1, -0.5, -1];
export function regimeOf(idxSeasons, breadth) {
  const iv = idxSeasons.filter(x => x != null);
  const ix = iv.length ? iv.reduce((a, s) => a + IDXV[s], 0) / iv.length : 0;
  const br = Math.max(-1, Math.min(1, (breadth - 50) / 25));
  const R = 0.6 * ix + 0.4 * br;
  return { R: +R.toFixed(2), label: R >= 0.35 ? '강세' : R <= -0.35 ? '약세' : '중립', ix: +ix.toFixed(2), breadth: +breadth.toFixed(1) };
}

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const r1 = x => Math.round(x * 10) / 10;
const pct = x => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}%`;

/* ------------------------------ 하루치 판단 ------------------------------ */

/** 그날 한 종목의 상태 */
function viewOf(x, i, D) {
  const s = x.s, sn = SEASONS[x.season[i]], age = i - x.runA[i] + 1;
  const prob = Math.round(x.ps[i]), ps5 = i >= 5 && x.season[i - 5] === x.season[i] ? x.ps[i] - x.ps[i - 5] : null;
  const sum = { season: sn, prob, align: x.align[i], dd: x.dd[i], ps5, ...dipOf(sn, age, s.m20[i] > 0 ? 100 * (s.p[i] / s.m20[i] - 1) : null) };
  return { code: x.code, name: x.name, sector: x.sector, px: s.p[i], sn, age, prob, align: x.align[i], dd: x.dd[i], ps5, sum,
    trend: trendScore(sum), r126: i >= 126 ? s.p[i] / s.p[i - 126] - 1 : null, mom60: i >= 60 ? s.p[i] / s.p[i - 60] - 1 : null,
    vol: { ok: true, vr1: r1(x.vr1[i]), vr5: r1(x.vr5[i]), surge: x.vr1[i] >= 2 || x.vr5[i] >= 1.5, dry: x.vr5[i] <= 0.6 },
    fresh: age <= 20, stale: s.d[i] < D, fit: x.fit || null, snI: x.season[i], pbEnt: x.pb?.get(i) || null, cf: x.cf ? x.cf[i] : -1,
    dev20: s.m20[i] > 0 ? 100 * (s.p[i] / s.m20[i] - 1) : null, m60: s.m60[i] || null,
    mc: x.sh > 0 && x.fx > 0 ? x.sh * s.p[i] * x.fx : null };                       // 원화 시가총액
}

const fundTxt = f => f ? `대장 ${Math.round(f.score)}(가속 ${f.p?.accel ?? '—'}·싼 정도 ${f.p?.value ?? '—'}%ile${f.info?.pe ? `·PER ${f.info.pe}` : f.fwdPe ? `·PER ${f.fwdPe}` : ''})` : '대장 점수 없음';
const trendTxt = v => `${v.sn} ${v.age}일째 · 확률 ${v.prob}% · ${v.align > 0 ? '정배열' : v.align < 0 ? '역배열' : '이평 혼조'} · 52주 고점 ${v.dd > -0.5 ? '신고가' : pct(v.dd)}`;

/** 전략별 후보·보유 판단. 반환 { cands:[{code, A, x(매력도 0~1), why}], hold(v, pos) → {exit|trim, why} | null, attrOf } */
function planOf(st, ctx) {
  const { views, fund } = ctx;
  const opOf = v => {
    if (v._op) return v._op;
    const f = fund.get(v.code);
    const row = f ? { score: f.score, p: f.p, flags: f.flags || (f.peak ? ['이익 정점 경계'] : []), fwdPe: f.fwdPe ?? f.info?.pe ?? null, peBasis: f.peBasis ?? 'trailing', revUp: f.revUp ?? null } : null;
    return (v._op = opinion(v.sum, row, v.vol));
  };
  const C = v => { const op = opOf(v); return op.combined ?? op.trend.score; };       // 종합 (가치 점수 없으면 추세)
  const fit3 = v => v.fit?.grade === 3;
  const seasonHold = v => (v.sn === '겨울' ? { exit: true, why: `겨울 전환 — 전량 청산 (${trendTxt(v)})` }
    : v.sn === '가을' ? { trim: 0.5, once: true, why: `가을 전환 — 절반 매도 (${trendTxt(v)})` } : null);
  const out = { cands: [] };

  if (st.id === 'S1') {                                              // 상위점수 — 베스트 종목만, 4단계 순서
    for (const v of views) {
      if (v.stale) continue;
      const T = v.trend ?? 0, c = C(v), f = fit3(v);
      if (T < 90 && c < 90) continue;
      const tier = c >= 90 && f ? 1 : T >= 90 && f ? 2 : c >= 90 ? 3 : 4, sc = tier % 2 ? c : T;
      out.cands.push({ code: v.code, A: (5 - tier) * 100 + sc, x: clamp((sc - 90) / 10, 0, 1),
        why: `${['', '종합 90+ · 계절 잘 맞음', '추세 90+ · 계절 잘 맞음', '종합 90+', '추세 90+'][tier]} (${tier}순위) — 추세 ${T} · 종합 ${c} · ${trendTxt(v)}` });
    }
    out.hold = v => { const T = v.trend ?? 0, c = C(v);
      if (T < 75 && c < 75) return { exit: true, why: `상위권 이탈 — 추세 ${T} · 종합 ${c} (둘 다 75 미만)` };
      return seasonHold(v); };
    out.attrOf = v => Math.max(v.trend ?? 0, C(v));
    return out;
  }
  if (st.id === 'S2') {                                              // 추세+가치 — 종합 점수
    for (const v of views) {
      if (v.stale || !(v.sn === '봄' || v.sn === '여름')) continue;
      const c = C(v), op = opOf(v);
      if (c < 75) continue;
      out.cands.push({ code: v.code, A: c, x: clamp((c - 75) / 20, 0, 1), why: `종합 ${c} — 추세 ${op.trend.score}·가치 ${op.value.score == null ? '—' : Math.round(op.value.score)} · ${trendTxt(v)}` });
    }
    out.hold = v => { const c = C(v); if (c < 60) return { exit: true, why: `종합 ${c}로 하락 (편출 기준 60)` }; return seasonHold(v); };
    out.attrOf = v => C(v);
    return out;
  }
  if (st.id === 'S3') {                                              // 가치투자 — 대장 점수
    for (const v of views) {
      const f = fund.get(v.code);
      if (v.stale || !f || f.score < 70 || f.peak || (f.p?.value ?? 50) < 35) continue;
      const A = clamp(0.8 * f.score + 0.2 * (f.p?.value ?? 50));
      out.cands.push({ code: v.code, A, x: clamp((A - 70) / 25, 0, 1), why: `${fundTxt(f)} · 이익 정점 신호 없음` });
    }
    out.hold = v => {
      const f = fund.get(v.code);
      if (!f) return null;
      if (f.peak) return { exit: true, why: `이익 정점 경계 — 가속 하위 ${f.p?.accel ?? '?'}%ile + 마진 하락 (${fundTxt(f)})` };
      if (f.score < 50) return { exit: true, why: `대장 점수 ${Math.round(f.score)}로 하락 (편출 기준 50)` };
      return null;
    };
    out.attrOf = v => { const f = fund.get(v.code); return f ? clamp(0.8 * f.score + 0.2 * (f.p?.value ?? 50)) : 0; };
    return out;
  }
  if (st.id === 'S4') {                                              // 여름풀매수 — 잘 맞음 + 여름 전환
    for (const v of views) {
      if (v.stale || !fit3(v) || v.sn !== '여름' || v.age > 5) continue;
      out.cands.push({ code: v.code, A: v.trend ?? 0, x: clamp(((v.trend ?? 0) - 70) / 30, 0, 1), why: `계절 잘 맞음 · 여름 전환 ${v.age}일째 · 추세+저점 ${v.trend} · ${trendTxt(v)}` });
    }
    out.hold = v => seasonHold(v);
    out.attrOf = v => v.trend ?? 0;
    return out;
  }
  if (st.id === 'S5') {                                              // 봄확정
    for (const v of views) {
      if (v.stale || !fit3(v) || v.sn !== '봄' || v.cf !== 1) continue;
      out.cands.push({ code: v.code, A: v.trend ?? 0, x: clamp(((v.trend ?? 0) - 60) / 30, 0, 1), why: `계절 잘 맞음 · 봄 확정 · 추세+저점 ${v.trend} · ${trendTxt(v)}` });
    }
    out.hold = v => (v.sn === '가을' || v.sn === '겨울' ? { exit: true, why: `${v.sn} 전환 — 전량 청산 (${trendTxt(v)})` }
      : v.sn === '봄' && v.cf === 0 ? { exit: true, why: `봄 확정이 풀림 — 반등 실패, 전량 청산 (${trendTxt(v)})` } : null);
    out.attrOf = v => v.trend ?? 0;
    return out;
  }
  if (st.id === 'S6') {                                              // 저점매수
    for (const v of views) {
      if (v.stale || v.sn !== '겨울' || v.age < 20 || v.dev20 == null || v.dev20 > -15) continue;
      out.cands.push({ code: v.code, A: -v.dev20, x: clamp((-v.dev20 - 15) / 15, 0, 1), why: `겨울 ${v.age}일째 · 20일선 대비 ${pct(v.dev20)} → 저점 매수` });
    }
    out.hold = (v, pos) => {
      if (v.m60 && v.px >= v.m60) return { exit: true, why: `60일선 회복 — 반등 목표 도달, 전량 청산 (${trendTxt(v)})` };
      if (pos.days >= 40) return { exit: true, why: `보유 ${pos.days}거래일 — 시간 청산 (${trendTxt(v)})` };
      return null;
    };
    out.attrOf = v => -(v.dev20 ?? 0);
    return out;
  }
  // S7 눌림매매 — 하루 한 종목 (손익비 1위)
  const cs = [];
  for (const v of views) {
    const e = v.pbEnt;
    if (v.stale || !e) continue;
    const { tgt, rr } = targetOf(e, v.px, v.snI);
    cs.push({ code: v.code, A: rr, x: clamp((rr - 1) / 2, 0, 1), stop: 100 * (e.stop / v.px - 1), extra: { pbStop: e.stop, pbTgt: tgt, pbSn0: v.snI },
      why: `눌림 진입 — 기준봉 이후 고점 대비 ${pct(e.dd)} · ${v.sn} ${v.age}일째 · 손절가 ${+e.stop.toFixed(2)} · 목표 ${+tgt.toFixed(2)}${v.snI >= 2 ? `(${e.lineK ? e.lineK + '일선' : '기준봉 이후 고점'})` : '(가을·겨울 전환까지 보유)'} · 손익비 ${rr}` });
  }
  cs.sort((a, b) => b.A - a.A);
  if (cs.length > 1) cs[0].why += ` · 후보 ${cs.length}개 중 손익비 1위`;
  out.cands = cs.slice(0, 1);
  out.hold = (v, pos) => {
    if (pos.pbStop && v.px < pos.pbStop) return { exit: true, why: `손절가 ${+pos.pbStop.toFixed(2)} 종가 이탈 — 전량 청산 (${trendTxt(v)})` };
    if (pos.pbSn0 <= 1 && (v.sn === '가을' || v.sn === '겨울')) return { exit: true, why: `${v.sn} 전환 — 봄·여름 진입분 전량 청산 (${trendTxt(v)})` };
    if (pos.pbSn0 >= 2 && pos.pbTgt && v.px >= pos.pbTgt) return { exit: true, why: `베이스라인 ${+pos.pbTgt.toFixed(2)} 도달 — 익절 청산 (${trendTxt(v)})` };
    return null;
  };
  out.attrOf = () => 0;
  return out;
}

/** 시가총액 등급별 종목 비중 상한 (원화) */
const sizeCap = mc => (mc == null ? 0.15 : mc >= 1e14 ? 0.35 : mc >= 1e13 ? 0.30 : mc >= 2e12 ? 0.22 : 0.15);

/** 그날 전략의 위험 관리 — 주식 비중 상한·종목 수. 장세 × 매크로 × 목표 진행, 3개월 손실 한도 */
function riskOf(st, book, eqNow, ctx) {
  const { regime, macro } = ctx, d = book.daily, n = d.length;
  if (book.halt > 0) return { cap: 0, hard: 0, slots: 0, note: `3개월 손실 한도(−20%) 도달 — 현금 대기 ${book.halt}거래일 남음` };
  const base = regime.label === '강세' ? 1 : regime.label === '약세' ? 0.4 : 0.7;
  const mk = macro ? Math.max(0.8, Math.min(1, 1 + 0.1 * macro.risk)) : 1;
  const ref = n >= GOAL.days ? d[n - GOAL.days][1] : CAPITAL, r63 = 100 * (eqNow / ref - 1);
  let goal = 1, gnote = '';
  if (st.tp && r63 >= GOAL.ret) { goal = 0.5; gnote = ` · 3개월 ${pct(r63)} — 목표 달성, 이익 보호(절반)`; }
  else if (r63 <= -10) { goal = 0.6; gnote = ` · 3개월 ${pct(r63)} — 방어(60%)`; }
  const hard = Math.round(100 * base * mk) / 100;                                    // 장세·매크로 상한 — 넘치면 줄여서 맞춤
  const cap = Math.round(100 * base * mk * goal) / 100, slots = Math.max(0, Math.min(MAX, Math.ceil(cap * MAX - 1e-9)));
  return { cap, hard, slots, note: `장세 ${regime.label}${macro ? ` · 매크로 ${macro.risk > 0 ? '+' : ''}${macro.risk}` : ''}${gnote} → 주식 상한 ${Math.round(cap * 100)}% · 최대 ${slots}종목` };
}


/* ------------------------------ 시뮬레이션 ------------------------------ */

export function newBook(start) { return { v: LAB_V, start, cash: CAPITAL, pos: {}, trades: [], daily: [], cool: {}, last: null, cap: 1, halt: 0 }; }

/**
 * 하루 처리 — book 을 그 자리에서 갱신
 * @param pxOf code → 그날 종가 (없으면 마지막 가격)
 */
function stepDay(st, book, D, ctx, m, pxOf, vmap) {
  const fee = FEE[m], plan = planOf(st, ctx);
  const value = () => book.cash + Object.values(book.pos).reduce((a, p) => a + p.sh * (pxOf(p.code) ?? p.cost), 0);
  const log = (side, p, sh, px, why, extra = {}) => {
    const v = vmap.get(p.code);
    book.trades.push({ d: D, side, code: p.code, name: p.name, sector: p.sector || null, px: +px.toFixed(4), sh: +sh.toFixed(4), amt: Math.round(sh * px),
      sn: v?.sn || null, why, ...extra });
  };
  const sell = (code, frac, why, kind) => {
    const p = book.pos[code], px = pxOf(code) ?? p.cost, sh = frac >= 0.999 ? p.sh : p.sh * frac;
    const gross = sh * px, net = gross * (1 - fee.sell), ret = 100 * (px * (1 - fee.sell) / p.cost - 1);
    book.cash += net;
    log(frac >= 0.999 ? '매도' : '일부 매도', p, sh, px, why, { ret: r1(ret), pnl: Math.round(net - sh * p.cost), days: p.days, kind });
    if (frac >= 0.999) { delete book.pos[code]; book.cool[code] = D; } else { p.sh -= sh; p.half = true; }
  };

  // 0) 보유 기간·경고 카운트
  for (const p of Object.values(book.pos)) { p.days++; const v = vmap.get(p.code); if (v && !v.stale) p.lastPx = v.px; }

  let eq = value();
  const invested = () => Object.values(book.pos).reduce((a, p) => a + p.sh * (pxOf(p.code) ?? p.cost), 0);

  // 1) 계좌 손실 한도 — 최근 3개월 고점 대비 −20% 면 전량 현금, 20거래일 쉼
  let pk = eq; for (const x of book.daily.slice(-GOAL.days)) pk = Math.max(pk, x[1]);
  if (!book.halt && Object.keys(book.pos).length && 100 * (eq / pk - 1) <= GOAL.loss) {
    for (const code of Object.keys(book.pos)) sell(code, 1, `계좌 손실 한도 — 최근 3개월 고점 대비 ${pct(100 * (eq / pk - 1))} (한도 ${GOAL.loss}%), 전량 현금 · ${GOAL.halt}거래일 쉼`, 'halt');
    book.halt = GOAL.halt; eq = value();
  }
  const risk = riskOf(st, book, eq, ctx);

  // 2) 편출 — 손절 · 익절(목표) · 시간 청산 · 전략 신호
  for (const code of Object.keys(book.pos)) {
    const p = book.pos[code], v = vmap.get(code);
    if (!v) { if (!ctx.held.has(code)) sell(code, 1, '유니버스에서 빠져 정리', 'drop'); continue; }
    if (v.stale) continue;
    const ret = 100 * (v.px / p.cost - 1), stop = p.stop ?? st.stopPct;
    if (ret <= stop) { sell(code, 1, `손절 — 매수가 대비 ${pct(ret)} (기준 ${+stop.toFixed(1)}%)`, 'stop'); continue; }
    if (st.tp) {
      if (ret >= GOAL.tp2) { sell(code, 1, `목표 수익 도달 — 매수가 대비 ${pct(ret)} (목표 +${GOAL.tp2}%), 전량 익절`, 'tp'); continue; }
      if (!st.tp1Off && !p.tp1 && ret >= GOAL.tp1) { sell(code, 0.5, `1차 익절 — 매수가 대비 ${pct(ret)} (+${GOAL.tp1}%), 절반`, 'tp'); p.tp1 = true; continue; }
      if (p.days >= GOAL.time && ret < GOAL.timeMin) { sell(code, 1, `보유 ${p.days}거래일 — 3개월 목표에 못 미침(${pct(ret)} < +${GOAL.timeMin}%), 시간 청산`, 'time'); continue; }
    }
    const h = plan.hold(v, p);
    if (!h) continue;
    if (h.once && p.half) continue;                                       // 가을 절반 매도는 한 번만
    const hard = /겨울|회피|정점|빠져|청산|풀림/.test(h.why);
    if (!hard && p.days < MIN_HOLD) continue;
    if (h.exit) sell(code, 1, h.why, 'signal');
    else if (h.trim) sell(code, h.trim, h.why, 'trim');
  }

  // 3) 주식 비중 상한 — 목표 진행(이익 보호·방어)은 새로 사지 않는 것으로만 맞추고, 장세·매크로 상한을 15%p 넘게 넘으면 같은 비율로 줄임
  eq = value();
  if (invested() / eq > risk.hard + 0.15) {
    const k = 1 - risk.hard / (invested() / eq);
    for (const code of Object.keys(book.pos)) sell(code, k, `주식 비중 상한 ${Math.round(risk.hard * 100)}%로 축소 — ${risk.note}`, 'cap');
  }

  // 4) 편입 — 매력도 순, 종목 수·비중 상한 안에서. 비중 = 시가총액 등급 상한 × 매력도, 한 거래 손실 ≤ 계좌 15%
  eq = value();
  const held = new Set(Object.keys(book.pos));
  const cands = plan.cands.filter(c => !held.has(c.code) && !(book.cool[c.code] && ctx.tdiff(book.cool[c.code], D) < COOL)).sort((a, b) => b.A - a.A);
  for (const c of cands) {
    if (Object.keys(book.pos).length >= risk.slots) break;
    const v = vmap.get(c.code), stop = Math.min(-1, c.stop ?? st.stopPct);
    const wSize = sizeCap(v.mc) * (0.6 + 0.4 * (c.x ?? 0.5)), wLoss = GOAL.tradeLoss / (Math.abs(stop) / 100);
    const room = Math.min(book.cash / eq, risk.cap - invested() / eq);
    const w = Math.min(wSize, wLoss, room);
    if (w < MIN_TRADE) break;
    const px = v.px, amt = w * eq, sh = amt * (1 - fee.buy) / px;
    book.cash -= amt;
    book.pos[c.code] = { code: c.code, name: v.name, sector: v.sector, sh, cost: px * (1 + fee.buy), in: D, days: 0, half: false, A0: r1(c.A), why0: c.why, warn: 0, lastPx: px, stop, ...(c.extra || {}) };
    const mcT = v.mc == null ? '시가총액 —' : `시가총액 ${v.mc >= 1e12 ? +(v.mc / 1e12).toFixed(1) + '조' : Math.round(v.mc / 1e8) + '억'}`;
    log('매수', book.pos[c.code], sh, px, `${c.why} → 비중 ${Math.round(100 * w)}% (${mcT} 상한 ${Math.round(sizeCap(v.mc) * 100)}% · 손절 ${+stop.toFixed(1)}%)`, { A: r1(c.A), w: r1(100 * w) });
  }

  for (const [code, d] of Object.entries(book.cool)) if (ctx.tdiff(d, D) >= COOL) delete book.cool[code];
  eq = value();
  book.cap = risk.cap; book.note = risk.note; book.last = D; book.slots = risk.slots;
  if (book.halt > 0) book.halt--;
  book.daily.push([D, Math.round(eq), r1(100 * invested() / eq)]);
}

/**
 * 여러 날 이어서 처리.
 * @param data { m, items(prepItem 결과), axis(처리할 날짜), idxSeasons(날짜→[s,s]), live:{fund:Map}|null, macroOf(D)→{risk}|null, cats }
 * @param books { S1: book, ... } — 없으면 새로 시작
 */
export function runDays(data, books, { upto = null } = {}) {
  const { m, items, axis } = data;
  const pos = new Map(items.map(x => [x.code, 0]));
  const byCode = new Map(items.map(x => [x.code, x]));
  // 두 날짜 사이 평일 수 (장부가 여러 번에 나눠 이어지므로 날짜만으로 센다)
  const tdiff = (a, b) => { let n = 0; for (let t = Date.parse(a) + 864e5; t <= Date.parse(b); t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) n++; } return n; };
  const processed = [];
  const starts = STRATS.map(st => books[st.id]?.last || null);
  const from = starts.every(Boolean) ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  for (const D of axis) {
    if (upto && D > upto) break;
    // 각 종목 포인터를 D 이하 마지막 봉으로 (이미 기록된 날은 포인터만 옮기고 건너뜀)
    for (const x of items) { let i = pos.get(x.code); const d = x.s.d; while (i + 1 < d.length && d[i + 1] <= D) i++; pos.set(x.code, i); }
    if (from && D <= from) continue;
    const views = [], vmap = new Map();
    for (const x of items) {
      const i = pos.get(x.code);
      if (x.s.d[i] > D || i < 130) continue;
      const v = viewOf(x, i, D);
      views.push(v); vmap.set(x.code, v);
    }
    if (!views.length) continue;
    // 상대강도 백분위 (6개월 수익률)
    const rr = views.filter(v => v.r126 != null).map(v => v.r126).sort((a, b) => a - b);
    const rs = new Map(views.filter(v => v.r126 != null).map(v => [v.code, 100 * lowerBound(rr, v.r126) / Math.max(1, rr.length - 1)]));
    const breadth = 100 * views.filter(v => v.sn === '봄' || v.sn === '여름').length / views.length;
    const regime = regimeOf(data.idxSeasons(D), breadth);
    const isLive = !!data.live;
    const fund = data.live?.fund || new Map();                        // 그날 대시보드 대장 점수 (없으면 대장 쓰는 전략은 현금)
    const macro = data.macroOf(D);
    const ctx = { views, fund, regime, macro, cats: data.cats, rs, tdiff, held: byCode,
      attr: (code, plan) => { const v = vmap.get(code); return v ? plan.attrOf(v) : 0; } };
    const pxOf = code => vmap.get(code)?.px ?? null;
    for (const st of STRATS) {
      const book = books[st.id] || (books[st.id] = newBook(D));
      if (book.last && D <= book.last) continue;
      stepDay(st, book, D, ctx, m, code => pxOf(code) ?? book.pos[code]?.lastPx ?? null, vmap);
      book.regime = regime; book.live = !!isLive;
    }
    processed.push({ D, regime, macro, live: !!isLive });
  }
  return processed;
}
function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; } return lo; }

/* ------------------------------ 성과 요약 ------------------------------ */

export const PERIODS = [['1D', '1일', 1], ['1W', '1주', 5], ['1M', '1개월', 21], ['3M', '3개월', 63], ['6M', '6개월', 126], ['1Y', '1년', 252], ['YTD', '올해', null], ['ALL', '누적', 0]];

/** 날짜·값 배열 [[d, v], ...] → 기간별 {amt, pct} */
export function periodsOf(series, base = CAPITAL) {
  const n = series.length;
  if (!n) return {};
  const last = series[n - 1][1], out = {};
  const yr = series[n - 1][0].slice(0, 4);
  for (const [k, , N] of PERIODS) {
    let ref;
    if (k === 'ALL') ref = base;
    else if (k === 'YTD') { const prev = series.filter(x => x[0] < `${yr}-01-01`); ref = prev.length ? prev[prev.length - 1][1] : base; }
    else ref = n - 1 - N >= 0 ? series[n - 1 - N][1] : null;
    out[k] = ref ? { amt: Math.round(last - ref), pct: +(100 * (last / ref - 1)).toFixed(2) } : null;
  }
  return out;
}

/** 전략 하나의 화면용 요약 */
export function summaryOf(st, book, m) {
  const daily = book.daily, n = daily.length, eq = n ? daily[n - 1][1] : CAPITAL, D = book.last;
  const series = daily.map(x => [x[0], x[1]]);
  const cum = 100 * (eq / CAPITAL - 1), cumAt = k => (n - 1 - k >= 0 ? 100 * (daily[n - 1 - k][1] / CAPITAL - 1) : 0);
  const today = book.trades.filter(t => t.d === D);
  const closed = book.trades.filter(t => t.side === '매도');
  let peak = CAPITAL, mdd = 0; for (const [, v] of daily) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const holdings = Object.values(book.pos).map(p => {
    const px = p.lastPx ?? p.cost, val = p.sh * px;
    return { code: p.code, name: p.name, sector: p.sector, px, cost: +p.cost.toFixed(4), in: p.in, days: p.days, ret: r1(100 * (px / p.cost - 1)), w: r1(100 * val / eq), amt: Math.round(val), half: p.half, A0: p.A0, why: p.why0 };
  }).sort((a, b) => b.w - a.w);
  return {
    id: st.id, no: st.no, name: st.name, tag: st.tag, desc: st.desc, criteria: st.criteria, m, start: book.start || (daily[0] && daily[0][0]) || null, asof: D, eq, cum: +cum.toFixed(2),
    d1: +(cum - cumAt(1)).toFixed(2), w1: +(cum - cumAt(5)).toFixed(2), mdd: +(100 * mdd).toFixed(2),
    periods: periodsOf(series), invested: n ? daily[n - 1][2] : 0, cap: book.cap, note: book.note || '',
    nHold: holdings.length, buys: today.filter(t => t.side === '매수' || t.side === '추가 매수').length, exits: today.filter(t => t.side === '매도').length,
    trades: book.trades.length, win: closed.length ? r1(100 * closed.filter(t => t.ret > 0).length / closed.length) : null,
    holdings, live: !!book.live,
  };
}
