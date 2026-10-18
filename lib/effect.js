// 국면 효과 — 'N일 후 수익률' 대신 국면이 실제로 하는 일(얼마나 오래, 얼마나 빨리, 위아래 어느 쪽으로)을 보여준다.
//   구간마다: hold(진입일→전환 확인일 거래일 수), mo(월 환산 = 20거래일 복리 속도, 10일 미만은 null),
//            ex(같은 기간 지수 대비 %p), next(다음 국면)
//   계절별: 월 환산은 그 계절에 머문 모든 날을 이어 붙인 복리 속도(짧은 구간이 숫자를 튀게 하지 않음)
//   전략 비교(기간: 연초·1개월·3개월·6개월·1년·2년·3년·5년, 시작일 종가에서 시드 1,000만원으로 새로 시작): 계속 보유 / 봄·여름만 보유(봄 확정·여름) / 단기진입 / 일목기준선 / 종합매매 / 눌림매매 / 저점매수 (토글: 익절·손절·저점매수·필터)
//   fit = 이 종목에 계절이 잘 맞는지 (상세 화면 맨 위 태그)
import { SEASONS, sma } from './engine.js';
import { pbScan, targetOf } from './pullback.js';
import { stSignals } from './engine2.js';

const MO = 20, MIN_MO = 10, WARMUP = 60, COST = 0.001, SEED = 10_000_000;     // 한 달 = 20거래일, 거래비용 회전율 1당 0.1%
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
export function effectOf(A, history, ix, keep = 1265, mc = {}, curvePer = null) {
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
  let curves = null;
  const C = { m20: sma(P, 20), m60: sma(P, 60), wage: new Int32Array(n) };     // 저점매수 재료 (겨울 경과일)
  for (let t = 0; t < n; t++) C.wage[t] = season[t] === 3 ? (t > 0 && season[t - 1] === 3 ? C.wage[t - 1] + 1 : 1) : 0;
  C.pb = new Map(pbScan(s, mc).ent.map(e => [e.t, e]));
  C.sig = stSignals(s, season);                                                  // 단기진입 신호일
  C.cf = A.cf || null;                                                           // 봄 확정(1)·미확정(0) — 없으면 봄을 모두 확정으로 본다                         // 눌림매매 재료 (진입일 → 기준봉·손절가·베이스라인)
  for (const [k, , t0] of PER) {
    if (t0 >= n - 1) continue;
    const row = { from: s.d[t0], to: s.d[n - 1], days: n - 1 - t0, p0: P[t0], s0: SEASONS[season[t0]] };
    const cv = k === curvePer ? { per: k, d: s.d.slice(t0), eq: {} } : null;   // 카드 누르면 차트에 그릴 날짜별 평가금액 — 요청한 기간만
    const rr = id => (cv ? (cv.eq[id] = []) : null);
    for (const st of STRATS) row[st.id] = runStrat(st.id, s, season, t0, C, rr(st.id));
    for (const v of VARIANTS) row[v] = runStrat(v, s, season, t0, C, rr(v));   // 화면 토글: T 익절 · S 손절 · D 저점매수 (일목기준선의 T·F 는 lib/kijun.js)
    if (cv) curves = cv;
    follows[k] = row;
  }
  const meta = { cost: COST * 100, seed: SEED, opts: OPTS, strats: STRATS.map(({ id, name, short, desc }) => ({ id, name, short, desc })), periods: PER.filter(([k]) => follows[k]).map(([k, l]) => [k, l]) };
  return { seasons, follows, ...meta, fit: fitOf(seasons, follows['5Y'] || follows['3Y'] || null, history), ...(curves ? { curves } : {}) };
}

/* ------------------------------ 전략 비교 ------------------------------ */
// 체결은 시작일·국면 판정일(또는 손절선 이탈일) 종가. 거래비용은 거래 금액의 0.1%. 시드 1,000만원.
// 시작일 진입: 봄·여름만 보유 = 봄 확정·여름이면 100% / 종합매매 = 그날 상태의 비중 / 눌림매매 = 눌림 진입일에만 / 단기진입 = 신호일에만 / 계속 보유 = 시작일 종가 100%
// 변형 키 = 전략id + '_' + 토글 글자(T 익절 · S 손절 · D 저점매수 · A 추가매수 · F 필터, 이 순서). 예) SS_TSD, KJ_F. 토글 없는 기본은 id 그대로.
export const STRATS = [
  { id: 'H', name: '계속 보유', short: '시작일 종가에 사서 끝까지 보유', desc: '시작일 종가에 100% 사서 그대로 들고 있기. [익절] 켜면 +15% 절반 · +30% 전량 매도, [손절] 켜면 진입가 −15% 종가 이탈 때 전량 매도하고 끝(현금 유지)' },
  { id: 'SS', name: '봄·여름만 보유', short: '봄 확정·여름 보유 · 그 밖엔 현금', desc: '봄 확정이거나 여름일 때만 100% 보유, 미확정 봄·가을·겨울은 현금. 시작일이 봄 확정·여름이면 바로 매수, 이후 봄 확정·여름 전환 때 매수, 그 밖으로 바뀌면 전량 매도 (확정 봄이 다시 미확정이 돼도 매도). [손절] 켜면 진입가 −15% 종가 이탈 때 전량 매도하고 다음 봄 확정(새로 확정되는 날)에 다시 진입' },
  { id: 'ST', name: '단기진입', short: '여름 중 20일 최고 종가 첫 돌파 + 거래량 2배↑ 100% → +10% 절반 · +20% 전량 · −15% 손절',
    desc: '진입: 그날 여름이고, 종가가 직전 20거래일 최고 종가를 처음 돌파(전일은 돌파 아님)하면서 거래량이 직전 20일 평균의 2배 이상이면 그날 종가에 100% 매수 / 익절: 진입가 대비 +10%에서 절반, +20%에서 전량 / 손절: 종가가 진입가 −15% 이하면 전량. 그 밖의 매도는 없고, 신호는 보유 중이 아닐 때만 받는다' },
  { id: 'SF', name: '종합매매', short: '미확정 봄 20% → 확정 봄 60% → 여름 100% → 가을 50% → 겨울 0% · 겨울 저점매수 100%',
    desc: '목표 수익(3개월 15~30%)에 맞춘 운용 — 계절과 봄 확정에 따라 비중을 맞춘다. 미확정 봄 20%(지지선 소량) · 봄 확정 60%(눌림 후 재돌파 확인) · 여름 100%(모멘텀 풀비중) · 가을 50%(절반 정리) · 겨울 0%. 여기에 겨울 저점매수: 겨울 20거래일+ · 20일선 대비 −15% 이하면 100% → 60일선 회복 · 40거래일 · 매수가 −15% 중 먼저 오는 날 저점매수분 정리(그때 계절 비중으로). 시작일에는 그날 상태의 비중으로 바로 시작. 비중이 바뀌는 날에만 그날 종가로 맞춘다. [익절] 켜면 평단 +15%에서 보유분 절반 · +30%에서 전량 매도(이후 비중이 올라가는 전환 때 다시 계절 비중으로), 가을 50% 매도는 그대로 적용. [손절] 켜면 평단 −15% 종가 이탈 때 전량 매도하고 다음 봄(새 봄 시작)부터 원래 비중 규칙대로 다시 진입 / 내 종목 백테스트(4.5년): 월 +2.25% · 기존 봄 40%·여름 100%·가을 50% + 저점매수 30% 조합 +2.01%' },
  { id: 'PB', name: '눌림매매', short: '급등 기준봉 뒤 눌림목 매수 → 손절가 종가 이탈·국면 기준 익절',
    desc: '기준봉: 5·10·20일선 정배열 + 종가 5일선 위 + 거래량 20일 평균 2배↑ + 종가 +3%↑ + 시가총액 3,000억↑. 눌림목: 기준봉 뒤 15거래일 안에 고점 대비 −3~−15% 조정 · 10일선 ×1.03 이하 · 20일선과 기준봉 시작가(전일 종가) 위 · 거래량이 기준봉의 50% 이하이면서 20일 평균 이하 · 20일선 상승 → 그날 종가 100% 매수. 손절: 기준봉 시작가와 진입가 −8% 중 높은 값을 종가가 깨면 전량. 익절: 봄·여름에 들어갔으면 가을·겨울 전환 때까지 보유, 가을·겨울에 들어갔으면 다음 베이스라인(진입가 위 가장 가까운 60·120일선, 없으면 기준봉 이후 고점)에 종가가 닿으면 전량. [익절] 켜면 진입가 +15% 절반 · +30% 전량도 함께 적용' },
  { id: 'DB', name: '저점매수', short: '겨울 20일+ · 20일선 −15% 이하 매수 → 60일선 회복·40일·−15% 매도', desc: '겨울이 20거래일 넘게 이어지고 종가가 20일선보다 15% 이상 아래면 100% 매수. 종가가 60일선을 회복하거나, 40거래일이 지나거나, 매수가 대비 −15%(본주)면 전량 매도' },
];

/** 전략별로 켤 수 있는 토글 글자 (T 익절 · S 손절 · D 저점매수 · A 추가매수 · F 필터). 서버는 이 조합만 계산한다 — 일목기준선(KJ)은 lib/kijun.js 가 같은 규칙으로 */
export const OPTS = { H: 'TS', SS: 'TSD', ST: 'D', KJ: 'TAF', SF: 'TS', PB: 'TD', DB: '' };
export const variantsOf = id => {
  const L = OPTS[id] || '', out = [];
  for (let m = 1; m < (1 << L.length); m++) { let s = ''; for (let i = 0; i < L.length; i++) if (m & (1 << i)) s += L[i]; out.push(`${id}_${s}`); }
  return out;
};
export const VARIANTS = STRATS.flatMap(x => variantsOf(x.id));
export const TP = { std: [[0.15, 0.5], [0.30, 1]], st: [[0.10, 0.5], [0.20, 1]] };   // 익절 단계 [수익률, 매도 비율] — 공통 / 단기진입
export const SLOSS = 0.15;                                                           // 손절 — 진입가(평단) 대비 −15% 종가 이탈
const MIX = new Set(['SF']);

/** 보유/현금 한 종목 전략 하나 (계속 보유 · 봄·여름만 보유 · 단기진입 · 눌림매매 · 저점매수) — key = id 또는 id_토글
 *  mode: 0 현금 · 1 기본(계절·계속) 보유 · 2 저점매수 보유 · 3 눌림 보유 · 4 단기진입 보유
 *  익절(T/단기진입)은 저점매수 보유분에는 적용 안 함. 손절(S): 계속 보유는 끝 · 봄·여름만 보유는 새 봄 확정 때까지 대기 */
function runSingle(key, s, season, t0, C, rec = null) {
  const [id, fl = ''] = key.split('_'), T = fl.includes('T'), SL = fl.includes('S'), dip = id === 'DB' || fl.includes('D');
  const P = s.p, n = P.length, lv = id === 'ST' ? TP.st : TP.std, fee = id === 'H' ? 1 / (1 + COST) : 1 - COST;
  let cash = SEED, sh = 0, cost = 0, mode = 0, stage = 0, trades = 0, blocked = false, dipT = 0, stop = 0, tgt = null, sn0 = 0, outT = -1;
  let eq = SEED, hi = SEED, lo = SEED, hiD = null, loD = null, dd = 0, ddAmt = 0, ddD = null;
  const buy = (t, m) => { sh = cash * fee / P[t]; cost = P[t]; cash = 0; mode = m; stage = 0; trades++; if (m === 2) dipT = t; };
  const sell = (t, f) => { const q = sh * f; cash += q * P[t] * (1 - COST); sh -= q; trades++; };
  const exit = (t, hold = false) => { sell(t, 1); sh = 0; mode = 0; stage = 0; if (hold) outT = t; };   // hold = 익절·손절로 나온 날은 같은 날 다시 사지 않음
  const dipSig = t => season[t] === 3 && C.wage[t] >= DIP.age && C.m20[t] > 0 && P[t] / C.m20[t] - 1 <= DIP.dev;
  const ok = t => season[t] === 1 || (season[t] === 0 && (!C.cf || C.cf[t] === 1));   // 봄·여름만 보유 = 봄 확정 · 여름
  const newConf = t => season[t] === 0 && (!C.cf || C.cf[t] === 1) && !(t > 0 && season[t - 1] === 0 && (!C.cf || C.cf[t - 1] === 1));   // 봄이 새로 확정되는 날
  for (let t = t0; t < n; t++) {
    const sn = season[t], first = t === t0, on = id === 'SS' && ok(t), turn = id === 'SS' && t > 0 && on !== ok(t - 1);
    if (mode === 2) {
      if (id === 'SS' && on) mode = 1;                                         // 저점매수 중 봄 확정·여름 → 계절 보유로
      else if (P[t] >= C.m60[t] || t - dipT >= DIP.hold || P[t] <= cost * (1 - DIP.stop)) exit(t);
    } else if (mode === 1) {
      if (id === 'SS' && !on) exit(t);                                         // 미확정 봄·가을·겨울 → 전량 매도
      else if (SL && P[t] <= cost * (1 - SLOSS)) { exit(t, true); blocked = true; }  // 손절 — 계속 보유는 여기서 끝, 봄·여름만 보유는 새 봄 확정까지 대기
    } else if (mode === 3) {
      if (P[t] < stop) exit(t);                                                // 손절가 종가 이탈
      else if (sn0 <= 1 ? sn >= 2 : P[t] >= tgt) exit(t);                      // 봄·여름 진입: 가을·겨울 전환 · 가을·겨울 진입: 베이스라인 도달
    } else if (mode === 4 && P[t] <= cost * (1 - SLOSS)) exit(t, true);              // 단기진입 손절
    if (sh > 0 && mode !== 2 && (T || id === 'ST')) {                          // 익절 — 한 번에 한 단계
      const r = P[t] / cost - 1;
      if (stage < 2 && r >= lv[1][0]) exit(t, true);
      else if (stage < 1 && r >= lv[0][0]) { sell(t, lv[0][1]); stage = 1; }
    }
    if (mode === 0 && outT !== t) {
      if (id === 'H') { if (first) buy(t, 1); }
      else if (id === 'SS') {
        if (blocked) { if (newConf(t)) { blocked = false; buy(t, 1); } }
        else if ((first || turn) && on) buy(t, 1);
        if (mode === 0 && dip && dipSig(t)) buy(t, 2);
      } else if (id === 'ST') {
        if (C.sig[t]) buy(t, 4);
        else if (dip && dipSig(t)) buy(t, 2);
      } else if (id === 'PB') {
        const e = C.pb.get(t);
        if (e) { buy(t, 3); stop = e.stop; sn0 = sn; tgt = targetOf(e, P[t], sn).tgt; }
        else if (dip && dipSig(t)) buy(t, 2);
      } else if (dip && dipSig(t)) buy(t, 2);                                  // DB
    }
    eq = cash + sh * P[t];
    if (rec) rec.push(Math.round(eq));                                         // 날짜별 평가금액 (상세 화면 차트용)
    if (eq > hi) { hi = eq; hiD = s.d[t]; }
    if (eq < lo) { lo = eq; loD = s.d[t]; }
    if (1 - eq / hi > dd) { dd = 1 - eq / hi; ddAmt = hi - eq; ddD = s.d[t]; }            // 최대하락 — 기간 내 평가금액 고점 대비
  }
  const won = x => Math.round(x), w = eq > 0 ? sh * P[n - 1] / eq : 0, px = x => +x.toFixed(x >= 1000 ? 0 : 2);
  const stopPx = mode === 3 ? stop : (mode === 4 || (mode === 1 && SL)) && sh > 0 ? cost * (1 - SLOSS) : null;
  const tgtPx = mode === 3 && sn0 >= 2 && tgt ? tgt : mode === 4 ? cost * (1 + lv[stage][0]) : null;
  return {
    cum: r2((eq / SEED - 1) * 100), pnl: won(eq - SEED), eq: won(eq),
    avg: sh > 0 ? px(cost) : null, pos: sh > 0 && w > 0.001 ? `${['', '보유', '저점매수', '눌림', '단기진입'][mode]} ${Math.round(w * 100)}%` : '현금', trades,
    stop: stopPx != null ? px(stopPx) : null, tgt: tgtPx != null ? px(tgtPx) : null,
    maxRet: r2((hi / SEED - 1) * 100), maxAmt: won(hi - SEED), maxD: hiD,
    maxLoss: r2((lo / SEED - 1) * 100), lossAmt: won(lo - SEED), lossD: loD,
    mdd: r2(-dd * 100), mddAmt: -won(ddAmt), mddD: ddD,
  };
}

/** 종합매매 — 비중형: 미확정 봄 20% · 확정 봄 60% · 여름 100% · 가을 50% · 겨울 0%, 겨울 저점매수 중이면 100%. 비중이 바뀌는 날 종가로 맞춤.
 *  기준 비중 bw 가 올라가면 bw 로 맞추고(익절·손절 상태 초기화), 내려가면 지금 보유분에 비례해 줄인다 (익절로 절반이 됐으면 가을엔 그 절반의 50%).
 *  익절(T): 평단 +15% 절반(목표 비중 ×0.5) · +30% 전량(×0). 손절(S): 평단 −15% 종가 이탈 시 전량, 다음 봄(새 봄 시작)부터 원래 규칙대로 */
export const MIX_W = { unconf: 0.2, conf: 0.6, summer: 1, autumn: 0.5, winter: 0, dip: 1 };
function runMix(key, s, season, t0, C, rec = null) {
  const [, fl = ''] = key.split('_'), T = fl.includes('T'), SL = fl.includes('S');
  const P = s.p, n = P.length, W = MIX_W;
  let cash = SEED, sh = 0, cost = 0, trades = 0, w = -1, bwp = -1, m = 1, stage = 0, blocked = false, dipT = -1, dipPx = 0, eq = SEED, hi = SEED, lo = SEED, hiD = null, loD = null, dd = 0, ddAmt = 0, ddD = null;
  const val = t => cash + sh * P[t];
  const to = (t, x) => {
    const e = val(t), cur = sh * P[t], d = x * e - cur;
    if (Math.abs(d) < e * 1e-6) return;
    trades++;
    if (d > 0) { const q = d / (1 + COST) / P[t]; cost = (sh * cost + q * P[t]) / (sh + q); sh += q; cash -= d; }
    else { const q = -d / P[t]; sh -= q; cash += -d * (1 - COST); if (sh * P[t] < 1) { sh = 0; cost = 0; } }
  };
  const dipSig = t => season[t] === 3 && C.wage[t] >= DIP.age && C.m20[t] > 0 && P[t] / C.m20[t] - 1 <= DIP.dev;
  for (let t = t0; t < n; t++) {
    const sn = season[t];
    if (dipT >= 0 && (P[t] >= C.m60[t] || t - dipT >= DIP.hold || P[t] <= dipPx * (1 - DIP.stop))) dipT = -1;
    if (dipT < 0 && dipSig(t)) { dipT = t; dipPx = P[t]; }
    const sw = sn === 0 ? (!C.cf || C.cf[t] === 1 ? W.conf : W.unconf) : sn === 1 ? W.summer : sn === 2 ? W.autumn : W.winter;
    const bw = Math.max(sw, dipT >= 0 ? W.dip : 0);
    if (blocked && sn === 0 && t > 0 && season[t - 1] !== 0) { blocked = false; m = 1; stage = 0; }   // 새 봄 시작 → 원래 비중 규칙대로 다시
    if (!blocked) {
      if (bw > bwp) { m = 1; stage = 0; if (w !== bw) { to(t, bw); w = bw; } }                      // 비중이 올라가는 전환 (첫날 포함) — 익절 상태 초기화
      else if (bw < bwp && bwp > 0) { w *= bw / bwp; to(t, w); }                                    // 내려가는 전환 — 보유분 비례 매도
      if (sh > 0) {
        const r = P[t] / cost - 1;
        if (SL && r <= -SLOSS) { to(t, 0); w = 0; blocked = true; }
        else if (T && stage < 2 && r >= TP.std[1][0]) { to(t, 0); w = 0; stage = 2; }
        else if (T && stage < 1 && r >= TP.std[0][0]) { w *= 1 - TP.std[0][1]; to(t, w); stage = 1; }
      }
    }
    bwp = bw;
    eq = val(t);
    if (rec) rec.push(Math.round(eq));
    if (eq > hi) { hi = eq; hiD = s.d[t]; }
    if (eq < lo) { lo = eq; loD = s.d[t]; }
    if (1 - eq / hi > dd) { dd = 1 - eq / hi; ddAmt = hi - eq; ddD = s.d[t]; }            // 최대하락 — 기간 내 평가금액 고점 대비
  }
  const won = x => Math.round(x), wt = eq > 0 ? sh * P[n - 1] / eq : 0;
  return {
    cum: r2((eq / SEED - 1) * 100), pnl: won(eq - SEED), eq: won(eq),
    avg: sh > 0 ? +cost.toFixed(cost >= 1000 ? 0 : 2) : null, pos: wt <= 0.001 ? '현금' : `${dipT >= 0 ? '저점매수 ' : ''}보유 ${Math.round(wt * 100)}%`, trades,
    stop: SL && sh > 0 ? +(cost * (1 - SLOSS)).toFixed(cost >= 1000 ? 0 : 2) : null,
    maxRet: r2((hi / SEED - 1) * 100), maxAmt: won(hi - SEED), maxD: hiD,
    maxLoss: r2((lo / SEED - 1) * 100), lossAmt: won(lo - SEED), lossD: loD,
    mdd: r2(-dd * 100), mddAmt: -won(ddAmt), mddD: ddD,
  };
}

/** 규칙 하나(키 = id 또는 id_토글)를 t0 종가부터 끝까지 시드 1,000만원으로 — 결과: 수익률·수익금·평단·최대수익·최대손실 */
function runStrat(key, s, season, t0, C, rec = null) {
  return MIX.has(key.split('_')[0]) ? runMix(key, s, season, t0, C, rec) : runSingle(key, s, season, t0, C, rec);
}

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
