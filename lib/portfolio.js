// 전략실 — 6개 전략 × 미국·한국. 전략마다 초기자본 1,000만원. 장부를 처음 만든 거래일부터 시작한다 (과거 재현 없음).
//   1호 국면       추세추종 — 국면 엔진만
//   2호 대장       가치투자 — 대장 엔진만
//   3호 국면+대장  종합 의견(Action) 그대로
//   4호 시황종합   국면+대장 + 매크로·장세로 노출 상한과 범주 가감
//   5호 장세필터   장세(지수 국면 + 시장폭)에 따라 추세 / 선별 / 방어 모드 전환 — 가격만
//   6호 생왕쇠사   생 파일럿 → 왕 불타기·손절선 본전 → 쇠 50% 익절 → 사 전량 청산 (종목별 손절선)
//
// 공통 규칙
//   - 최대 10종목, 보통 5종목까지. 6번째부터는 매력도가 아주 높은 종목(기준 + 남은 폭의 60% 이상)만.
//   - 비중은 매력도로 정한다: 기준을 넘는 정도 x(0~1) → 8% + 32%·x^1.3 (압도적이면 최대 40%). 매력적인 종목이 적으면 나머지는 현금.
//   - 정기 리밸런싱 없음. 매도 신호·노출 상한·더 매력적인 종목으로의 교체가 있을 때만 거래한다.
//   - 체결은 신호가 나온 날 종가. 수수료·세금: 미국 매수·매도 각 0.1%, 국내 매수 0.05%·매도 0.25%. 소수점 주식 허용(단순 누적 수익률).
//   - 미국 전략도 원화 1,000만원으로 표시하지만 환율 변동은 넣지 않았다 (달러 수익률을 그대로 적용).
//   - 과거 펀더멘털·점수는 그 시점 값을 정확히 되살리기 어려워서 과거 재현은 하지 않는다. 매일 그날의 실시간 국면·대장 점수로 판단해서
//     장부에 기록하고, 한 번 기록된 날은 다시 계산하지 않는다 — 새 거래일만 이어 붙인다.
import { SEASONS, features, psOf } from './engine.js';
import { classifyOf } from './engine2.js';
import { trendScore, opinion } from './opinion.js';

export const CAPITAL = 10_000_000;
const FEE = { US: { buy: 0.001, sell: 0.001 }, KR: { buy: 0.0005, sell: 0.0025 } };
const SOFT = 5, MAX = 10, MIN_HOLD = 3, COOL = 5, MIN_TRADE = 0.03;

export const STRATS = [
  { id: 'S1', no: 1, name: '국면', tag: '추세추종', T: 70,
    desc: '생왕쇠사 국면 엔진만으로 사고판다. 여름(旺)에 올라탄 종목, 막 봄(生)으로 돌아선 정배열 종목을 사고, 가을에 절반·겨울에 전량 판다.',
    criteria: ['편입: 여름, 또는 봄 전환 20일 이내 + 이평 정배열. 52주 고점 대비 −25% 안쪽', '매력도 = 국면 점수(계절·확률·정배열·고점 거리) 60% + 6개월 상대강도 백분위 40% — 70 이상만',
      '편출: 겨울 전환 → 전량 · 가을 전환 → 절반, 가을이 10거래일 넘게 이어지면 나머지 · 매수가 대비 −15% → 손절'] },
  { id: 'S2', no: 2, name: '대장', tag: '가치투자', T: 70,
    desc: '대장 엔진(실적 가속·성장·마진·현금·질·밸류·위험)만으로 고른다. 실적이 좋아지는데 아직 비싸지 않은 종목.',
    criteria: ['편입: 대장 점수 70 이상 + 싼 정도 백분위 35 이상 + 이익 정점 경계 아님', '매력도 = 대장 점수 80% + 싼 정도 20%',
      '편출: 대장 점수 50 미만 · 이익 정점 경계(가속 하위 20% + 마진 하락) · 매수가 대비 −20%',
      '대장 점수는 그날 대시보드 펀더멘털 표의 점수(미국 분기 재무+선행 EPS, 국내 컨센서스) 그대로'] },
  { id: 'S3', no: 3, name: '국면+대장', tag: '종합의견', T: 65,
    desc: '종목 표의 종합 의견(Action)을 그대로 따른다. 추세 60% + 가치 40% 종합 점수와 국면×밸류×거래량 판단.',
    criteria: ['편입: 종합 의견이 \'핵심 보유\'(여름 + 실적 점수 60↑) 또는 \'선취매 후보\'(봄 + 싸거나 실적 60↑), 종합 점수 65 이상',
      '매력도 = 종합 점수 (추세 60% + 가치 40%)', '편출: \'회피\' 또는 겨울 → 전량 · \'비중 축소\'·\'차익실현 경계\' → 절반, 10거래일 넘게 이어지면 나머지 · −15% 손절'] },
  { id: 'S4', no: 4, name: '시황종합', tag: '국면+대장+매크로', T: 65,
    desc: '3호의 종목 선택에 시황을 얹는다. 지수 국면·시장폭(장세)과 매크로 위험도로 주식 비중 상한을 정하고, 매크로 범주 뷰로 매력도를 가감한다.',
    criteria: ['시황 점수 = 장세 점수 50% + 매크로 위험도 50% (그날 매크로 위험도가 없으면 장세 점수만)',
      '노출 상한: 시황 +0.35 이상 100% · 중간 70% · −0.35 이하 35% — 상한을 넘으면 보유 종목을 같은 비율로 줄임',
      '매력도 = 종합 점수 + 범주 뷰 가감(Over +5, Under −10)', '편입·편출 신호는 3호와 같음'] },
  { id: 'S5', no: 5, name: '장세필터', tag: '모드 전환', T: 65,
    desc: '시장 전체가 어느 계절인지 먼저 보고 전략을 바꾼다. 강세장에선 추세추종, 중립장에선 주도주만, 약세장에선 거의 현금.',
    criteria: ['장세 점수 = 지수 국면 60%(여름 +1·봄 +0.5·가을 −0.5·겨울 −1, 두 지수 평균) + 시장폭 40%(유니버스 봄+여름 비율, 50% 기준)',
      '강세(+0.35↑) 추세 모드: 1호와 같은 후보, 기준 65, 노출 100%', '중립 선별 모드: 여름 + 상대강도 상위 20% + 52주 고점 −10% 안쪽, 기준 72, 노출 60%',
      '약세(−0.35↓) 방어 모드: 여름 + 상대강도 상위 10% + 고점 −8% 안쪽, 기준 78, 노출 20%', '편출: 1호 규칙 + 모드가 바뀌어 기준을 못 맞추면 매도'] },
  { id: 'S6', no: 6, name: '생왕쇠사', tag: '단계 매매', T: 60,
    desc: '국면 단계마다 비중을 바꾼다. 사(겨울)에서 막 벗어난 생(봄)에 시험 매수, 왕(여름)에 불타기로 풀 비중, 쇠(가을)에 절반 익절, 사(겨울)에 전량 청산.',
    criteria: ['생(生) 진입: 겨울 → 봄 전환 5거래일 이내 종목에 계획 비중의 40%만 파일럿 매수. 손절선 = 사 국면 최저가와 매수가 −10% 중 높은 값 — 종가가 깨면 즉시 전량 손절',
      '왕(旺) 진입: 보유 종목이 여름으로 넘어가면 계획 비중 100%까지 추가 매수하고 손절선을 평균 매수가(본전)로 올림. 여름 전환 5거래일 이내 신규 종목은 처음부터 100%, 손절선 −10%',
      '쇠(衰) 신호: 가을 전환 시 보유분의 50% 차익 실현', '사(死) 진입: 겨울 전환 시 잔여 물량 전량 매도 · 물타기 없음',
      '계획 비중 = 매력도(국면 점수 60% + 6개월 상대강도 40%)로 정한 비중 — 기준 60'] },
];

/* ------------------------------ 데이터 준비 ------------------------------ */

/** 종목별 시계열 계산 (판정·확률·정배열·고점거리·거래량·상대강도용 수익률) */
export function prepItem(it, P, cal) {
  const s = it.s, n = s.p.length, season = classifyOf(s, P), { F } = features(s, season);
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
  return { ...it, season, ps, align, dd, runA, vr1, vr5 };
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
  const sum = { season: sn, prob, align: x.align[i], dd: x.dd[i], ps5 };
  let prevS = null, prevLow = null;                                     // 직전 국면과 그 구간 최저가 (생왕쇠사 손절선)
  if (age <= 5) { const a = x.runA[i]; if (a > 0) { prevS = SEASONS[x.season[a - 1]]; const b = x.runA[a - 1]; let lo = Infinity; for (let k = b; k < a; k++) lo = Math.min(lo, s.p[k]); prevLow = isFinite(lo) ? lo : null; } }
  return { code: x.code, name: x.name, sector: x.sector, px: s.p[i], sn, age, prob, align: x.align[i], dd: x.dd[i], ps5, sum, prevS, prevLow,
    trend: trendScore(sum), r126: i >= 126 ? s.p[i] / s.p[i - 126] - 1 : null, mom60: i >= 60 ? s.p[i] / s.p[i - 60] - 1 : null,
    vol: { ok: true, vr1: r1(x.vr1[i]), vr5: r1(x.vr5[i]), surge: x.vr1[i] >= 2 || x.vr5[i] >= 1.5, dry: x.vr5[i] <= 0.6 },
    fresh: age <= 20, stale: s.d[i] < D };
}

const fundTxt = f => f ? `대장 ${Math.round(f.score)}(가속 ${f.p?.accel ?? '—'}·싼 정도 ${f.p?.value ?? '—'}%ile${f.info?.pe ? `·PER ${f.info.pe}` : f.fwdPe ? `·PER ${f.fwdPe}` : ''})` : '대장 점수 없음';
const trendTxt = v => `${v.sn} ${v.age}일째 · 확률 ${v.prob}% · ${v.align > 0 ? '정배열' : v.align < 0 ? '역배열' : '이평 혼조'} · 52주 고점 ${v.dd > -0.5 ? '신고가' : pct(v.dd)}`;

/** 전략별 후보·보유 판단. 반환 { cands:[{code, A, why}], hold(v, pos) → {exit|trim, why} | null, cap, note } */
function planOf(st, ctx) {
  const { views, fund, regime, macro, cats, rs } = ctx;
  const rsOf = v => rs.get(v.code) ?? 50;
  const trendA = v => clamp(0.6 * v.trend + 0.4 * rsOf(v));            // 국면 점수 60% + 6개월 상대강도 백분위 40%
  const trendCand = v => (v.sn === '여름' || (v.sn === '봄' && v.fresh && v.align > 0)) && v.dd > -25;
  const opOf = v => {
    if (v._op) return v._op;
    const f = fund.get(v.code);
    const row = f ? { score: f.score, p: f.p, flags: f.flags || (f.peak ? ['이익 정점 경계'] : []), fwdPe: f.fwdPe ?? f.info?.pe ?? null, peBasis: f.peBasis ?? 'trailing', revUp: f.revUp ?? null } : null;
    return (v._op = opinion(v.sum, row, v.vol));
  };
  const out = { cands: [], cap: 1, note: '' };

  if (st.id === 'S1' || st.id === 'S5') {
    let T = st.T, filt = v => trendCand(v), cap = 1, mode = '추세';
    if (st.id === 'S5') {
      if (regime.label === '중립') { mode = '선별'; T = 72; cap = 0.6; filt = v => v.sn === '여름' && rsOf(v) >= 80 && v.dd > -10; }
      else if (regime.label === '약세') { mode = '방어'; T = 78; cap = 0.2; filt = v => v.sn === '여름' && rsOf(v) >= 90 && v.dd > -8; }
      out.note = `장세 ${regime.label}(${regime.R >= 0 ? '+' : ''}${regime.R}) → ${mode} 모드`;
    }
    out.cap = cap; out.T = T;
    for (const v of views) if (!v.stale && filt(v)) {
      const A = trendA(v);
      if (A >= T) out.cands.push({ code: v.code, A, why: `${st.id === 'S5' ? out.note + ' · ' : ''}${trendTxt(v)} · 상대강도 상위 ${Math.max(1, 100 - Math.round(rsOf(v)))}%` });
    }
    out.hold = (v, pos) => {
      if (v.sn === '겨울') return { exit: true, why: `겨울 전환 — 하락 추세 확정 (${trendTxt(v)})` };
      if (v.sn === '가을') {
        if (!pos.half) return { trim: 0.5, why: `가을 전환 — 고점 대비 이탈, 절반 매도 (${trendTxt(v)})` };
        if (v.age > 10) return { exit: true, why: `가을이 ${v.age}거래일째 — 회복 없이 길어져 나머지 매도` };
      }
      if (st.id === 'S5' && !filt(v) && v.sn !== '가을' && pos.days >= MIN_HOLD) return { exit: true, why: `${out.note} — 모드 기준(${mode}) 미달로 매도` };
      return null;
    };
    out.attrOf = v => trendA(v);
    out.stop = -15;
    return out;
  }

  if (st.id === 'S6') {
    out.T = st.T;
    for (const v of views) {
      if (v.stale || v.age > 5) continue;
      const A = trendA(v), W = weightOf(Math.max(A, st.T), st.T);
      if (v.sn === '봄' && v.prevS === '겨울') {
        const stopPx = Math.max(v.prevLow ?? 0, v.px * 0.90);
        out.cands.push({ code: v.code, A, w: 0.4 * W, why: `생(生) 진입 — 겨울에서 막 넘어옴 · ${trendTxt(v)} → 파일럿 40%, 손절선 ${stopPx.toFixed(2)} (사 국면 최저가와 −10% 중 높은 값)`,
          extra: { stage: 1, stopPx, stopKind: v.prevLow != null && v.prevLow >= v.px * 0.90 ? '사 국면 최저가' : '매수가 −10%', W } });
      } else if (v.sn === '여름') {
        out.cands.push({ code: v.code, A, w: W, why: `왕(旺) 진입 — ${trendTxt(v)} → 풀 비중, 손절선 −10%`, extra: { stage: 2, stopPx: v.px * 0.90, stopKind: '매수가 −10%', W }, min: st.T });
        // 봄 파일럿은 매력도 기준 없이 (막 돌아선 종목은 국면 점수가 낮게 나온다)
      }
    }
    out.adds = (v, p) => (v.sn === '여름' && p.stage === 1 ? { why: `왕(旺) 확인 — 불타기로 계획 비중 100%, 손절선을 본전으로 (${trendTxt(v)})` } : null);
    out.hold = (v, pos) => {
      if (pos.stopPx && v.px < pos.stopPx) return { exit: true, why: `손절선 이탈 — 종가 ${v.px.toFixed(2)} < 손절선 ${pos.stopPx.toFixed(2)} (${pos.stopKind || '손절선'})` };
      if (v.sn === '겨울') return { exit: true, why: `사(死) 진입 — 잔여 물량 전량 청산 (${trendTxt(v)})` };
      if (v.sn === '가을' && !pos.half) return { trim: 0.5, why: `쇠(衰) 신호 — 보유분 50% 차익 실현 (${trendTxt(v)})` };
      return null;
    };
    out.attrOf = v => trendA(v);
    out.stop = -100; out.noSwap = true;                                  // 공통 손절·교체 대신 종목별 손절선
    return out;
  }

  if (st.id === 'S2') {
    out.T = st.T;
    for (const v of views) {
      const f = fund.get(v.code);
      if (v.stale || !f || f.score < 70 || f.peak || (f.p?.value ?? 50) < 35) continue;
      const A = clamp(0.8 * f.score + 0.2 * (f.p?.value ?? 50));
      if (A >= st.T) out.cands.push({ code: v.code, A, why: `${fundTxt(f)} · 이익 정점 신호 없음` });
    }
    out.hold = v => {
      const f = fund.get(v.code);
      if (!f) return null;
      if (f.peak) return { exit: true, why: `이익 정점 경계 — 가속 하위 ${f.p?.accel ?? '?'}%ile + 마진 하락 (${fundTxt(f)})` };
      if (f.score < 50) return { exit: true, why: `대장 점수 ${Math.round(f.score)}로 하락 (편출 기준 50)` };
      return null;
    };
    out.attrOf = v => { const f = fund.get(v.code); return f ? clamp(0.8 * f.score + 0.2 * (f.p?.value ?? 50)) : 0; };
    out.stop = -20;
    return out;
  }

  // S3 · S4 — 종합 의견
  let cap = 1;
  if (st.id === 'S4') {
    const M = macro != null ? 0.5 * regime.R + 0.5 * Math.max(-1, Math.min(1, macro.risk / 2)) : regime.R;
    cap = M >= 0.35 ? 1 : M <= -0.35 ? 0.35 : 0.7;
    out.note = `시황 ${M >= 0 ? '+' : ''}${M.toFixed(2)} (장세 ${regime.label} ${regime.R >= 0 ? '+' : ''}${regime.R}${macro != null ? ` · 매크로 위험도 ${macro.risk > 0 ? '+' : ''}${macro.risk}` : ' · 매크로 위험도 없음'}) → 주식 상한 ${Math.round(cap * 100)}%`;
  }
  out.cap = cap; out.T = st.T;
  for (const v of views) {
    if (v.stale) continue;
    if (!(v.sn === '여름' || v.sn === '봄')) continue;
    const op = opOf(v);
    if (op.stance !== '핵심 보유' && op.stance !== '선취매 후보') continue;
    let A = op.combined ?? op.trend.score, tilt = '';
    if (st.id === 'S4' && cats) {
      const view = cats[v.code];
      if (view && /Over/.test(view)) { A += 5; tilt = ` · 범주 ${view} +5`; }
      else if (view && /Under|하향/.test(view)) { A -= 10; tilt = ` · 범주 ${view} −10`; }
    }
    A = clamp(A);
    if (A >= st.T) out.cands.push({ code: v.code, A, why: `종합 의견 '${op.stance}' — 추세 ${op.trend.score}·가치 ${op.value.score == null ? '—' : Math.round(op.value.score)} → 종합 ${op.combined}${tilt} · ${op.why[0] || ''}` });
  }
  out.hold = (v, pos) => {
    const op = opOf(v);
    if (v.sn === '겨울' || op.stance === '회피') return { exit: true, why: `종합 의견 '${op.stance}' (${v.sn}) — ${op.why[0] || ''}` };
    if (['비중 축소', '비중 축소 검토', '차익실현 경계'].includes(op.stance)) {
      if (!pos.half) return { trim: 0.5, why: `종합 의견 '${op.stance}' — 절반 매도 · ${op.why[0] || ''}` };
      if (pos.warn >= 10) return { exit: true, why: `'${op.stance}'가 ${pos.warn}거래일째 — 나머지 매도` };
      return { warn: true };
    }
    return null;
  };
  out.attrOf = v => { const op = opOf(v); return clamp(op.combined ?? op.trend.score); };
  out.stop = -15;
  return out;
}

/** 매력도 → 목표 비중 */
const weightOf = (A, T) => { const x = clamp((A - T) / Math.max(1, 100 - T), 0, 1); return 0.08 + 0.32 * Math.pow(x, 1.3); };

/* ------------------------------ 시뮬레이션 ------------------------------ */

export function newBook(start) { return { start, cash: CAPITAL, pos: {}, trades: [], daily: [], cool: {}, last: null, cap: 1 }; }

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

  // 1) 편출 — 손절 · 국면/점수 신호
  for (const code of Object.keys(book.pos)) {
    const p = book.pos[code], v = vmap.get(code);
    if (!v) { if (!ctx.held.has(code)) sell(code, 1, '유니버스에서 빠져 정리', 'drop'); continue; }
    if (v.stale) continue;
    const ret = 100 * (v.px / p.cost - 1);
    if (ret <= plan.stop) { sell(code, 1, `손절 — 매수가 대비 ${pct(ret)} (기준 ${plan.stop}%)`, 'stop'); continue; }
    const h = plan.hold(v, p);
    if (h?.warn) { p.warn = (p.warn || 0) + 1; continue; }
    if (!h) { p.warn = 0; continue; }
    const hard = /겨울|회피|정점|빠져|손절선|사\(死\)/.test(h.why);
    if (!hard && p.days < MIN_HOLD) continue;
    if (h.exit) sell(code, 1, h.why, 'signal');
    else if (h.trim) sell(code, h.trim, h.why, 'trim');
  }

  // 2) 노출 상한 — 넘으면 같은 비율로 줄임
  let eq = value();
  const invested = () => Object.values(book.pos).reduce((a, p) => a + p.sh * (pxOf(p.code) ?? p.cost), 0);
  if (plan.cap < 1 && invested() / eq > plan.cap + 0.05) {
    const k = 1 - plan.cap / (invested() / eq);
    for (const code of Object.keys(book.pos)) sell(code, k, `노출 상한 ${Math.round(plan.cap * 100)}%로 축소 — ${plan.note}`, 'cap');
  }

  // 2.5) 불타기 — 보유 종목 비중 늘리기 (6호)
  if (plan.adds) for (const code of Object.keys(book.pos)) {
    const p = book.pos[code], v = vmap.get(code); if (!v || v.stale) continue;
    const a = plan.adds(v, p); if (!a) continue;
    eq = value();
    const cur = p.sh * v.px, tgt = Math.min((p.W || 0) * eq, cur + book.cash), amt = tgt - cur;
    p.stage = 2; p.stopPx = p.cost; p.stopKind = '본전';                   // 손절선 본전 (추가 매수 전 평균가)
    if (amt / eq < MIN_TRADE) continue;
    const sh = amt * (1 - fee.buy) / v.px;
    p.cost = (p.sh * p.cost + amt) / (p.sh + sh); p.sh += sh; book.cash -= amt; p.stopPx = p.cost;
    log('추가 매수', p, sh, v.px, `${a.why} → 비중 ${Math.round(100 * tgt / eq)}%`, { w: r1(100 * tgt / eq) });
  }

  // 3) 편입 — 매력도 순으로 빈 자리·현금만큼
  eq = value();
  const held = new Set(Object.keys(book.pos));
  const cands = plan.cands.filter(c => !held.has(c.code) && !(book.cool[c.code] && ctx.tdiff(book.cool[c.code], D) < COOL)).sort((a, b) => b.A - a.A);
  const strong = plan.T + 0.6 * (100 - plan.T);
  for (const c of cands) {
    const n = Object.keys(book.pos).length;
    if (n >= MAX) break;
    if (n >= SOFT && c.A < strong && !plan.noSwap) continue;
    const room = Math.min(book.cash / eq, plan.cap - invested() / eq);
    if (c.min != null && c.A < c.min) continue;
    let w = c.w ?? weightOf(c.A, plan.T);
    if (room < MIN_TRADE) {
      // 교체 — 보유 중 가장 덜 매력적인 종목보다 15 이상 높으면 갈아탄다
      const weakest = Object.values(book.pos).map(p => ({ p, A: ctx.attr(p.code, plan) })).sort((a, b) => a.A - b.A)[0];
      if (plan.noSwap || !weakest || c.A < weakest.A + 15 || weakest.p.days < MIN_HOLD) break;
      sell(weakest.p.code, 1, `교체 — ${vmap.get(c.code)?.name || c.code}(매력도 ${Math.round(c.A)})가 이 종목(${Math.round(weakest.A)})보다 15 이상 높음`, 'swap');
      eq = value();
    }
    const room2 = Math.min(book.cash / eq, plan.cap - invested() / eq);
    w = Math.min(w, room2);
    if (w < MIN_TRADE) continue;
    const v = vmap.get(c.code), px = v.px, amt = w * eq, sh = amt * (1 - fee.buy) / px;
    book.cash -= amt;
    const A0 = c.A;
    book.pos[c.code] = { code: c.code, name: v.name, sector: v.sector, sh, cost: px * (1 + fee.buy), in: D, days: 0, half: false, A0: r1(A0), why0: c.why, warn: 0, lastPx: px, ...(c.extra || {}) };
    log('매수', book.pos[c.code], sh, px, `${c.why} → 매력도 ${Math.round(A0)}, 비중 ${Math.round(100 * w)}%`, { A: r1(A0), w: r1(100 * w) });
  }

  for (const [code, d] of Object.entries(book.cool)) if (ctx.tdiff(d, D) >= COOL) delete book.cool[code];
  eq = value();
  book.cap = plan.cap; book.note = plan.note || ''; book.last = D;
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
