// 국면 효과 — 'N일 후 수익률' 대신 국면이 실제로 하는 일(얼마나 오래, 얼마나 빨리, 위아래 어느 쪽으로)을 보여준다.
//   구간마다: hold(진입일→전환 확인일 거래일 수), mo(월 환산 = 20거래일 복리 속도, 10일 미만은 null),
//            ex(같은 기간 지수 대비 %p), next(다음 국면)
//   계절별: 월 환산은 그 계절에 머문 모든 날을 이어 붙인 복리 속도(짧은 구간이 숫자를 튀게 하지 않음)
//   전략 비교(기간: 연초·1개월·3개월·6개월·1년·2년·3년·5년, 시작일 종가에서 시드 1,000만원으로 새로 시작): 계속 보유 / 눌림매매 / 봄·여름만 보유 / 봄 진입·가을 매도 / 레버리지 / 저점매수 / 생왕쇠사
//   fit = 이 종목에 계절이 잘 맞는지 (상세 화면 맨 위 태그)
import { SEASONS, sma } from './engine.js';
import { pbScan, targetOf } from './pullback.js';

const MO = 20, MIN_MO = 10, WARMUP = 60, COST = 0.001, SEED = 10_000_000, STOP = 0.90;     // 한 달 = 20거래일, 거래비용 회전율 1당 0.1%
const DIP = { age: 20, dev: -0.15, hold: 40, stop: 0.15 };   // 겨울 저점매수: 겨울 20일+ · 20일선 대비 −15% 이하 매수 → 60일선 회복 · 40일 · −15% 매도

const moOf = (r, hold) => (hold >= MIN_MO && r > -100 ? +((Math.pow(1 + r / 100, MO / hold) - 1) * 100).toFixed(2) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
const r2 = x => (x == null || !isFinite(x) ? null : +x.toFixed(2));

/** 계절별 연속 구간 [시즌번호, 시작, 끝] */
function runsOf(season, n) {
  const runs = []; let a = 0;
  for (let t = 1; t <= n; t++) if (t === n || season[t] !== season[a]) { runs.push([season[a], a, t - 1]); a = t; }
  return runs;
}

/** 계절 하나에 머문 날들을 이어 붙인 결과 — eps: [{r(%), hold, mx, mdd, next}] */
function pool(eps) {
  const done = eps.filter(e => !e.ongoing);
  let lr = 0, days = 0; for (const e of done) { lr += Math.log(1 + e.rEnd / 100); days += e.hold; }
  const next = {}; for (const e of done) if (e.next) next[e.next] = (next[e.next] || 0) + 1;
  return {
    n: eps.length, done: done.length,
    days: done.length ? Math.round(done.reduce((a, e) => a + e.days, 0) / done.length) : null,
    med: r2(med(done.map(e => e.rEnd))),
    mo: days ? r2((Math.exp(lr * MO / days) - 1) * 100) : null,
    up: done.length ? Math.round(100 * done.filter(e => e.rEnd > 0).length / done.length) : null,
    mx: done.length ? r2(done.reduce((a, e) => a + e.mx, 0) / done.length) : null,
    mdd: done.length ? r2(done.reduce((a, e) => a + e.mdd, 0) / done.length) : null,
    next,
  };
}

/**
 * 종목 하나의 국면 효과.
 * A = analyze 결과 {s, season}, history = historyOf 결과(최신순), ix = 지수 Series 또는 null, keep = 표시 창
 */
export function effectOf(A, history, ix, keep = 1265, mc = {}) {
  const { s, season } = A, n = s.p.length, P = s.p, t0 = Math.max(WARMUP, n - keep);
  const runs = runsOf(season, n), byStart = new Map(runs.map((r, i) => [s.d[r[1]], i]));
  // 구간별 보강
  for (const h of history) {
    const i = byStart.get(h.a); if (i == null) continue;
    const [, a, b] = runs[i], exit = h.ongoing ? n - 1 : b + 1;
    h.hold = Math.max(1, exit - a);
    h.mo = h.ongoing ? null : moOf(h.rEnd, h.hold);
    h.next = i + 1 < runs.length ? SEASONS[runs[i + 1][0]] : null;
    if (ix) {
      const i0 = ix.at(h.a), i1 = ix.at(h.x);
      h.ex = i0 >= 0 && i1 >= 0 ? r2(h.rEnd - (ix.p[i1] / ix.p[i0] - 1) * 100) : null;
    }
  }
  // 계절별
  const seasons = Object.fromEntries(SEASONS.map(nm => [nm, pool(history.filter(h => h.s === nm))]));
  // 전략 비교 — 기간마다 시작일 종가에서 시드 1,000만원으로 새로 시작 (이전 보유 상태를 이어받지 않음)
  const base = Math.max(WARMUP, n - keep);
  const at = N => Math.max(base, n - 1 - N);
  const y0 = s.d[n - 1].slice(0, 4) + '-01-01'; let ty = n - 1; while (ty > base && s.d[ty] >= y0) ty--;
  const PER = [['YTD', '연초', ty], ['1M', '1개월', at(21)], ['3M', '3개월', at(63)], ['6M', '6개월', at(126)], ['1Y', '1년', at(252)], ['2Y', '2년', at(504)], ['3Y', '3년', at(756)], ['5Y', '5년', base]];
  const follows = {};
  const C = { m20: sma(P, 20), m60: sma(P, 60), wage: new Int32Array(n) };     // 저점매수 재료 (겨울 경과일)
  for (let t = 0; t < n; t++) C.wage[t] = season[t] === 3 ? (t > 0 && season[t - 1] === 3 ? C.wage[t - 1] + 1 : 1) : 0;
  C.pb = new Map(pbScan(s, mc).ent.map(e => [e.t, e]));                         // 눌림매매 재료 (진입일 → 기준봉·손절가·베이스라인)
  for (const [k, , t0] of PER) {
    if (t0 >= n - 1) continue;
    const row = { from: s.d[t0], to: s.d[n - 1], days: n - 1 - t0, p0: P[t0], s0: SEASONS[season[t0]] };
    for (const st of STRATS) row[st.id] = runStrat(st.id, s, season, t0, C);
    for (const v of VARIANTS) row[v] = runStrat(v, s, season, t0, C);   // 화면 토글: 2 = 2배 레버리지, D = 겨울 저점매수 추가
    follows[k] = row;
  }
  const meta = { cost: COST * 100, seed: SEED, strats: STRATS.map(({ id, name, short, desc }) => ({ id, name, short, desc })), periods: PER.filter(([k]) => follows[k]).map(([k, l]) => [k, l]) };
  return { seasons, follows, ...meta, fit: fitOf(seasons, follows['5Y'] || follows['3Y'] || null, history) };
}

/* ------------------------------ 전략 비교 ------------------------------ */
// 체결은 시작일·국면 판정일(또는 손절선 이탈일) 종가. 거래비용은 거래 금액의 0.1%. 시드 1,000만원.
// 시작일 진입: 봄·여름만 보유 = 봄·여름이면 100% / 봄 진입·가을 매도 = 봄 '전환' 때만 / 레버리지 = 봄·여름이면 본주 100% / 눌림매매 = 눌림 진입일에만
//             생왕쇠사 = 진입 조건(겨울→봄 전환, 여름 전환)이 올 때만 / 계속 보유 = 시작일 종가 100%
export const STRATS = [
  { id: 'H', name: '계속 보유', short: '시작일 종가에 사서 끝까지 보유', desc: '시작일 종가에 100% 사서 그대로 들고 있기' },
  { id: 'PB', name: '눌림매매', short: '급등 기준봉 뒤 눌림목 매수 → 손절가 종가 이탈·국면 기준 익절',
    desc: '기준봉: 5·10·20일선 정배열 + 종가 5일선 위 + 거래량 20일 평균 2배↑ + 종가 +3%↑ + 시가총액 3,000억↑. 눌림목: 기준봉 뒤 15거래일 안에 고점 대비 −3~−15% 조정 · 10일선 ×1.03 이하 · 20일선과 기준봉 시작가(전일 종가) 위 · 거래량이 기준봉의 50% 이하이면서 20일 평균 이하 · 20일선 상승 → 그날 종가 100% 매수. 손절: 기준봉 시작가와 진입가 −8% 중 높은 값을 종가가 깨면 전량. 익절: 봄·여름에 들어갔으면 가을·겨울 전환 때까지 보유, 가을·겨울에 들어갔으면 다음 베이스라인(진입가 위 가장 가까운 60·120일선, 없으면 기준봉 이후 고점)에 종가가 닿으면 전량' },
  { id: 'SS', name: '봄·여름만 보유', short: '봄·여름 보유 · 가을·겨울 현금', desc: '시작일이 봄·여름이면 바로 100% 매수, 가을·겨울이면 현금. 이후 봄·여름 전환 때 매수, 가을·겨울 전환 때 전량 매도' },
  { id: 'SF', name: '봄 진입, 가을 매도', short: '봄 전환 때만 진입 → 여름 보유 → 가을 전량 매도 → 겨울 관망', desc: '봄으로 전환될 때만 100% 매수 → 여름 보유 → 가을 전량 매도 → 겨울 관망' },
  { id: 'LV', name: '레버리지 전략', short: '봄 본주 → 여름 불타기(2배) → 가을 전량 매도', desc: '시작일이 봄·여름이면 본주 100% 매수, 이후 봄 전환 때 본주 매수 → 봄→여름 전환 시 여름 불타기(2배 레버리지, 여름 구간 수익률 × 2) → 가을 전환 때 전량 매도 → 겨울 관망' },
  { id: 'DB', name: '저점매수', short: '겨울 20일+ · 20일선 −15% 이하 매수 → 60일선 회복·40일·−15% 매도', desc: '겨울이 20거래일 넘게 이어지고 종가가 20일선보다 15% 이상 아래면 100% 매수. 종가가 60일선을 회복하거나, 40거래일이 지나거나, 매수가 대비 −15%(본주)면 전량 매도' },
  { id: 'SWS', name: '생왕쇠사', short: '생 40% → 왕 100%(손절선 본전) → 쇠 50% 익절 → 사 청산', desc: '겨울→봄 전환 때 생 파일럿 40%·손절선(직전 국면 최저가와 −10% 중 높은 값) → 여름 전환 때 풀 비중·손절선 본전(새로 들어가면 −10%) → 가을 50% 익절 → 겨울 전량 청산. 시작일엔 진입 조건이 와야만 산다' },
];

export const VARIANTS = ['SS2', 'SF2', 'SSD', 'SFD', 'SS2D', 'SF2D', 'PB2', 'PBD', 'PB2D'];
const ONOFF = new Set(['SS', 'SF', 'DB', 'SS2', 'SF2', 'SSD', 'SFD', 'SS2D', 'SF2D']);
const PBS = new Set(['PB', 'PB2', 'PBD', 'PB2D']);

/** 보유/현금 두 상태만 있는 전략 (봄·여름 보유 · 봄 진입·가을 매도 · 저점매수, 2배·저점매수 토글 조합)
 *  보유 중 평가금액 = 진입 금액 × (1 + L × 진입가 대비 수익률) — 구간 안에서 재조정 없음 (레버리지 전략과 같은 방식)
 *  mode: 0 현금 · 1 계절 보유 · 2 저점매수 보유 (저점매수 매도 조건 전에 SS 는 봄·여름, SF 는 봄 전환이 오면 계절 보유로 넘어감) */
function runOnOff(id, s, season, t0, C) {
  const P = s.p, n = P.length, base = id.slice(0, 2), L = id.includes('2') ? 2 : 1, dip = base === 'DB' || id.endsWith('D');
  let mode = 0, E = SEED, Es = 0, Pe = 0, dipT = 0, trades = 0, eq = SEED, hi = SEED, lo = SEED, hiD = null, loD = null;
  const val = t => (mode ? Math.max(0, Es * (1 + L * (P[t] / Pe - 1))) : E);
  const enter = (t, m) => { Es = E * (1 - COST * L); Pe = P[t]; mode = m; trades++; if (m === 2) dipT = t; };
  const exit = t => { E = val(t) * (1 - COST * L); mode = 0; trades++; };
  const dipSig = t => season[t] === 3 && C.wage[t] >= DIP.age && C.m20[t] > 0 && P[t] / C.m20[t] - 1 <= DIP.dev;
  for (let t = t0; t < n; t++) {
    const sn = season[t], entry = t > 0 && sn !== season[t - 1], first = t === t0;
    if (mode === 2) {
      if (base === 'SS' && sn <= 1) mode = 1;                                  // 저점매수 중 봄·여름 → 계절 보유로
      else if (base === 'SF' && entry && sn === 0) mode = 1;                   // 저점매수 중 봄 전환 → 계절 보유로
      else if (P[t] >= C.m60[t] || t - dipT >= DIP.hold || P[t] <= Pe * (1 - DIP.stop)) exit(t);
    } else if (mode === 1 && sn >= 2) exit(t);                                 // 가을·겨울 → 전량 매도
    if (mode === 0) {
      if (base === 'SS' && (first || entry) && sn <= 1) enter(t, 1);
      else if (base === 'SF' && entry && sn === 0) enter(t, 1);
      else if (dip && dipSig(t)) enter(t, 2);
    }
    eq = val(t);
    if (eq > hi) { hi = eq; hiD = s.d[t]; }
    if (eq < lo) { lo = eq; loD = s.d[t]; }
  }
  const won = x => Math.round(x);
  return {
    cum: r2((eq / SEED - 1) * 100), pnl: won(eq - SEED), eq: won(eq),
    avg: mode ? +Pe.toFixed(Pe >= 1000 ? 0 : 2) : null, pos: mode ? `${L === 2 ? '2배 ' : ''}${mode === 2 ? '저점매수' : '보유'} 100%` : '현금', trades,
    maxRet: r2((hi / SEED - 1) * 100), maxAmt: won(hi - SEED), maxD: hiD,
    maxLoss: r2((lo / SEED - 1) * 100), lossAmt: won(lo - SEED), lossD: loD,
  };
}

/** 눌림매매 (2배·저점매수 토글). mode: 0 현금 · 2 저점매수 보유 · 3 눌림 보유 */
function runPB(id, s, season, t0, C) {
  const P = s.p, n = P.length, L = id.includes('2') ? 2 : 1, dip = id.endsWith('D');
  let mode = 0, E = SEED, Es = 0, Pe = 0, dipT = 0, trades = 0, eq = SEED, hi = SEED, lo = SEED, hiD = null, loD = null, stop = 0, tgt = null, sn0 = 0;
  const val = t => (mode ? Math.max(0, Es * (1 + L * (P[t] / Pe - 1))) : E);
  const enter = (t, m) => { Es = E * (1 - COST * L); Pe = P[t]; mode = m; trades++; if (m === 2) dipT = t; };
  const exit = t => { E = val(t) * (1 - COST * L); mode = 0; trades++; };
  const dipSig = t => season[t] === 3 && C.wage[t] >= DIP.age && C.m20[t] > 0 && P[t] / C.m20[t] - 1 <= DIP.dev;
  for (let t = t0; t < n; t++) {
    const sn = season[t];
    if (mode === 3) {
      if (P[t] < stop) exit(t);                                                   // 손절가 종가 이탈
      else if (sn0 <= 1 ? sn >= 2 : P[t] >= tgt) exit(t);                         // 봄·여름 진입: 가을·겨울 전환 · 가을·겨울 진입: 베이스라인 도달
    } else if (mode === 2 && (P[t] >= C.m60[t] || t - dipT >= DIP.hold || P[t] <= Pe * (1 - DIP.stop))) exit(t);
    if (mode === 0) {
      const e = C.pb.get(t);
      if (e) { enter(t, 3); stop = e.stop; sn0 = sn; tgt = targetOf(e, P[t], sn).tgt; }
      else if (dip && dipSig(t)) enter(t, 2);
    }
    eq = val(t);
    if (eq > hi) { hi = eq; hiD = s.d[t]; }
    if (eq < lo) { lo = eq; loD = s.d[t]; }
  }
  const won = x => Math.round(x);
  return {
    cum: r2((eq / SEED - 1) * 100), pnl: won(eq - SEED), eq: won(eq),
    avg: mode ? +Pe.toFixed(Pe >= 1000 ? 0 : 2) : null, pos: mode ? `${L === 2 ? '2배 ' : ''}${mode === 2 ? '저점매수' : '눌림'} 100%` : '현금', trades,
    stop: mode === 3 ? +stop.toFixed(stop >= 1000 ? 0 : 2) : null, tgt: mode === 3 && sn0 >= 2 && tgt ? +tgt.toFixed(tgt >= 1000 ? 0 : 2) : null,
    maxRet: r2((hi / SEED - 1) * 100), maxAmt: won(hi - SEED), maxD: hiD,
    maxLoss: r2((lo / SEED - 1) * 100), lossAmt: won(lo - SEED), lossD: loD,
  };
}

/** 규칙 하나를 t0 종가부터 끝까지 시드 1,000만원으로 — 결과: 수익률·수익금·평단·최대수익·최대손실 */
function runStrat(id, s, season, t0, C) {
  if (PBS.has(id)) return runPB(id, s, season, t0, C);
  if (ONOFF.has(id)) return runOnOff(id, s, season, t0, C);
  const P = s.p, n = P.length;
  let cash = SEED, sh = 0, cost = 0, stop = 0, half = false, trades = 0;
  let lev = 0, Es = 0, Ps = 0, avgL = 0;                                  // 레버리지: 0 현금 · 1 본주 · 2 여름 2배
  const val = t => cash + sh * P[t];
  const to = (t, w) => {                                                  // 평가금액 대비 비중 w 로 맞춤
    const eq = val(t), cur = sh * P[t], tgt = Math.max(0, w) * eq, d = tgt - cur;
    if (Math.abs(d) < 1e-6) return;
    trades++;
    if (d > 0) { const buy = d / (1 + COST); cost = (sh * cost + buy) / (sh + buy / P[t]); sh += buy / P[t]; cash -= d; }
    else { const q = -d / P[t]; sh -= q; cash += -d * (1 - COST); if (sh * P[t] < 1) { sh = 0; cost = 0; } }
  };
  const prevLow = t => { const a = runStart(season, t), b = a > 0 ? runStart(season, a - 1) : 0; let lo = Infinity; for (let k = b; k < a; k++) lo = Math.min(lo, P[k]); return isFinite(lo) ? lo : P[t] * STOP; };
  let eq = SEED, hi = SEED, lo = SEED, hiD = null, loD = null;
  for (let t = t0; t < n; t++) {
    const sn = season[t], prev = t > 0 ? season[t - 1] : sn, entry = sn !== prev, first = t === t0;
    if (id === 'LV') {
      // 평가 — 여름 2배는 구간 단순 수익률 × 2 (구간 안에서는 재조정 없음)
      if (lev === 2) eq = Math.max(0, Es * (1 + 2 * (P[t] / Ps - 1)));
      else if (lev === 1) eq = sh * P[t];
      else eq = cash;
      const conv = mode => {
        if (mode === lev) return;
        eq *= 1 - COST * Math.abs(mode - lev); trades++;
        if (mode === 2) { Es = eq; Ps = P[t]; cash = 0; sh = 0; }
        else if (mode === 1) { if (lev === 0) avgL = P[t]; cash = 0; sh = eq / P[t]; }
        else { cash = eq; sh = 0; avgL = 0; }
        if (mode === 2 && lev === 0) avgL = P[t];
        lev = mode;
      };
      if (first) { if (sn <= 1) conv(1); }
      else if (entry) {
        if (sn === 0 && lev === 0) conv(1);
        else if (sn === 1 && prev === 0 && lev === 1) conv(2);
        else if (sn >= 2) conv(0);                                       // 가을 전환 → 전량 매도 (겨울 관망)
      }
    } else {
      if (id === 'H') { if (first) to(t, 1); }
      else if (id === 'SWS') {
        if (sh > 0 && stop > 0 && P[t] < stop) { to(t, 0); half = false; stop = 0; }   // 손절선 이탈 → 종가 전량
        else if (entry) {
          if (sn === 0 && prev === 3 && sh === 0) { to(t, 0.4); half = false; stop = Math.max(prevLow(t), P[t] * STOP); }
          else if (sn === 1) {
            if (sh === 0) { to(t, 1); half = false; stop = P[t] * STOP; }
            else { to(t, 1); stop = cost; }                                // 불타기 — 풀 비중 + 손절선 본전
          } else if (sn === 2 && sh > 0 && !half) { to(t, (sh * P[t] / val(t)) * 0.5); half = true; }
          else if (sn === 3 && sh > 0) { to(t, 0); half = false; stop = 0; }
        }
      }
      eq = val(t);
    }
    if (eq > hi) { hi = eq; hiD = s.d[t]; }
    if (eq < lo) { lo = eq; loD = s.d[t]; }
  }
  const isL = id === 'LV';
  const w = isL ? (lev === 2 ? 2 : lev) : (eq > 0 ? sh * P[n - 1] / eq : 0);
  const avg = isL ? (lev ? avgL : null) : (sh > 0 ? cost : null);
  const pos = isL ? ['현금', '본주 100%', '2배 레버리지'][lev] : w <= 0.001 ? '현금' : `보유 ${Math.round(w * 100)}%`;
  const won = x => Math.round(x);
  return {
    cum: r2((eq / SEED - 1) * 100), pnl: won(eq - SEED), eq: won(eq),
    avg: avg ? +avg.toFixed(avg >= 1000 ? 0 : 2) : null, pos, trades,
    maxRet: r2((hi / SEED - 1) * 100), maxAmt: won(hi - SEED), maxD: hiD,
    maxLoss: r2((lo / SEED - 1) * 100), lossAmt: won(lo - SEED), lossD: loD,
  };
}
function runStart(season, t) { let a = t; while (a > 0 && season[a - 1] === season[t]) a--; return a; }

/** 이 종목에 계절이 잘 맞는가 — 계절별 월 환산 차이 + 봄·여름 보유가 계속 보유를 이겼나 */
function fitOf(seasons, F, history) {
  const done = history.filter(h => !h.ongoing).length;
  const mo = k => seasons[k]?.mo;
  const avg = a => { const b = a.filter(v => v != null); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : null; };
  const bull = avg([mo('봄'), mo('여름')]), bear = avg([mo('가을'), mo('겨울')]);
  if (done < 8 || bull == null || bear == null) return { grade: 0, label: '표본 부족', why: `끝난 국면 ${done}번 — 판단하기엔 적어` };
  const edge = bull - bear;
  let sc = edge >= 3 ? 2 : edge >= 1 ? 1 : edge < 0 ? -2 : 0;
  if (mo('여름') != null && mo('여름') > 0) sc++;
  if (mo('겨울') != null && mo('겨울') < 0) sc++;
  let strat = '';
  if (F?.SS && F?.H) {
    if (F.SS.cum > F.H.cum) sc++;
    if (F.SS.maxLoss - F.H.maxLoss >= 10) sc++;
    strat = ` · 봄·여름 보유 ${F.SS.cum >= 0 ? '+' : ''}${F.SS.cum}% vs 계속 보유 ${F.H.cum >= 0 ? '+' : ''}${F.H.cum}%`;
  }
  const f1 = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
  const grade = sc >= 4 ? 3 : sc >= 2 ? 2 : 1;
  return { grade, score: sc, label: grade === 3 ? '계절 잘 맞음' : grade === 2 ? '계절 보통' : '계절 안 맞음',
    why: `월 환산 봄·여름 ${f1(bull)} vs 가을·겨울 ${f1(bear)}${strat}` };
}

/** 유니버스 전체 — 같은 계절의 기준선 (전략실 단계에서 하루 한 번). items: prepItem 결과 */
export function universeEffect(items, keep = 1265) {
  const acc = SEASONS.map(() => ({ lr: 0, days: 0, n: 0, up: 0, len: [], next: {} }));
  let used = 0;
  for (const x of items) {
    const P = x.s.p, n = P.length, season = x.season, from = Math.max(WARMUP, n - keep);
    const runs = runsOf(season, n); let any = false;
    for (let i = 0; i < runs.length - 1; i++) {        // 끝난 구간만
      const [si, a, b] = runs[i]; if (a < from) continue;
      const exit = b + 1, r = P[exit] / P[a];
      if (!(r > 0) || !isFinite(r)) continue;
      const c = acc[si]; c.lr += Math.log(r); c.days += exit - a; c.n++; if (r > 1) c.up++; c.len.push(b - a + 1);
      const nx = SEASONS[runs[i + 1][0]]; c.next[nx] = (c.next[nx] || 0) + 1; any = true;
    }
    if (any) used++;
  }
  const seasons = Object.fromEntries(SEASONS.map((nm, k) => {
    const c = acc[k];
    return [nm, { n: c.n, mo: c.days ? r2((Math.exp(c.lr * MO / c.days) - 1) * 100) : null, up: c.n ? Math.round(100 * c.up / c.n) : null,
      days: c.len.length ? Math.round(med(c.len)) : null, next: c.next }];
  }));
  return { n: used, seasons };
}
