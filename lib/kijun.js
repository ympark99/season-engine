// 일목기준선 매매 (상세 화면 전략 비교) — 지지·저항 계산 때 받아 둔 일봉(시가·고가·저가·종가·거래량, 약 1년 2개월)으로 돌린다.
//   기준선 K = (최근 26봉 최고 고가 + 최저 저가) / 2 · 거래량↑ = 당일 거래량 > 직전 30일 평균
//   장대음봉 = 음봉 몸통이 직전 20일 평균 몸통의 1.5배 이상이면서 시가 대비 −2% 이상
//   진입 50%  : 돌파일(전일 종가 ≤ K, 당일 종가 > K) + 양봉 + 거래량↑, 또는 이틀 연속 K 위 마감(그 전날은 K 이하) — 종가 매수
//   추가 25%×2: 보유 중 기준선 터치(종가가 K +1.5% 이내 또는 K 밑) — 직전 진입·터치 뒤 K 위 3% 이상 벌어졌다 돌아온 터치만
//              K 밑 마감 터치는 거래량 30일 평균 이하 + 장대음봉 아님일 때만 사고 '검증'에 들어간다
//   전량 매도  : ① 종가 < K 이면서 장대음봉 또는 거래량↑ ② 이틀 연속 K 밑 마감
//              ③ 검증 — 약한 이탈 다음 날 K 위 마감 실패, 또는 회복한 다음 날 다시 K 밑 마감
//   필터(토글): 돌파 종가 > K×1.01 · 횡보(10일간 K 변화 ±1% 이내 + 20일간 종가가 K 를 3번 이상 넘나듦) 중엔
//              추가매수 안 하고, 진입은 종가가 최근 20일 최고 종가를 넘을 때만
const COST = 0.001, SEED = 10_000_000, K = 26, CONF = 2;   // CONF — 거래량 돌파가 없어도 K 위 연속 마감 이 날수면 진입
const r2 = x => (x == null || !isFinite(x) ? null : +x.toFixed(2));

/** 지표 준비 — O: {d,o,h,l,c,v} 오래된 순 */
export function kjPrep(O) {
  const n = O.c.length, kj = new Array(n).fill(null), va = new Array(n).fill(null), ba = new Array(n).fill(null);
  for (let t = K - 1; t < n; t++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = t - K + 1; j <= t; j++) { if (O.h[j] > hi) hi = O.h[j]; if (O.l[j] < lo) lo = O.l[j]; }
    kj[t] = (hi + lo) / 2;
  }
  for (let t = 30; t < n; t++) { let s = 0; for (let j = t - 30; j < t; j++) s += O.v[j] || 0; va[t] = s / 30; }
  for (let t = 20; t < n; t++) { let s = 0; for (let j = t - 20; j < t; j++) s += Math.abs(O.c[j] - O.o[j]); ba[t] = s / 20; }
  return { kj, va, ba };
}

/** t0(시작일 인덱스) 종가부터 끝까지 시드 1,000만원 — 결과 모양은 다른 전략과 같음 */
export function runKJ(O, X, t0, filter) {
  const { c, o, v, d } = O, n = c.length, { kj, va, ba } = X;
  let cash = SEED, sh = 0, cost = 0, trades = 0, adds = 0, armed = false, below = 0, check = 0;
  let eq = SEED, hi = SEED, lo = SEED, hiD = null, loD = null;
  const val = t => cash + sh * c[t];
  const to = (t, w) => {                                                     // 평가금액 대비 비중 w 로 맞춤
    const e = val(t), d0 = Math.max(0, w) * e - sh * c[t];
    if (Math.abs(d0) < 1e-6) return;
    trades++;
    if (d0 > 0) { const buy = d0 / (1 + COST); cost = (sh * cost + buy) / (sh + buy / c[t]); sh += buy / c[t]; cash -= d0; }
    else { const q = -d0 / c[t]; sh -= q; cash += -d0 * (1 - COST); if (sh * c[t] < 1) { sh = 0; cost = 0; } }
  };
  const sell = t => { to(t, 0); adds = 0; armed = false; below = 0; check = 0; };
  const sideways = t => {
    if (t < 30 || kj[t - 10] == null) return false;
    if (Math.abs(kj[t] / kj[t - 10] - 1) >= 0.01) return false;
    let x = 0; for (let j = t - 19; j <= t; j++) if (kj[j - 1] != null && (c[j] > kj[j]) !== (c[j - 1] > kj[j - 1])) x++;
    return x >= 3;
  };
  const hh20 = t => { let m = -Infinity; for (let j = Math.max(0, t - 20); j < t; j++) m = Math.max(m, c[j]); return m; };
  for (let t = t0; t < n; t++) {
    const k = kj[t];
    if (k != null && va[t] != null && t > 0 && kj[t - 1] != null) {
      const volUp = v[t] > va[t], bull = c[t] > o[t];
      const bigBear = c[t] < o[t] && ba[t] != null && o[t] - c[t] >= 1.5 * ba[t] && (o[t] - c[t]) / o[t] >= 0.02;
      const side = filter && sideways(t - 1);
      if (sh > 0) {
        const under = c[t] < k;
        if (under && (bigBear || volUp)) sell(t);                                  // ① 진짜 이탈
        else if (under && (below >= 1 || check)) sell(t);                         // ② 이틀 연속 이탈 · ③ 검증 실패
        else {
          if (check === 1 && !under) check = 2;                                  // 약한 이탈 다음 날 회복 — 하루 더 지켜봄
          else if (check === 2 && !under) check = 0;
          if (c[t] >= k * 1.03) armed = true;
          const touch = armed && c[t] <= k * 1.015;
          if (touch && adds < 2 && !side) { to(t, sh * c[t] / val(t) + 0.25); adds++; armed = false; }
          else if (touch) armed = false;
          if (under) { below = 1; check = 1; } else below = 0;                    // 약한 이탈 (거래량 적고 장대음봉 아님) → 검증
        }
      } else {
        const cross = c[t - 1] <= kj[t - 1] && c[t] > k * (filter ? 1.01 : 1);
        let conf = t >= CONF && kj[t - CONF] != null && !(c[t - CONF] > kj[t - CONF]);   // 이틀 연속 K 위 마감 (그 전날은 K 이하)
        for (let j = 0; j < CONF && conf; j++) if (!(c[t - j] > kj[t - j] * (filter ? 1.01 : 1))) conf = false;
        if (((cross && bull && volUp) || conf) && (!side || c[t] > hh20(t))) { to(t, 0.5); adds = 0; armed = false; below = 0; check = 0; }
      }
    }
    eq = val(t);
    if (eq > hi) { hi = eq; hiD = d[t]; }
    if (eq < lo) { lo = eq; loD = d[t]; }
  }
  const w = eq > 0 ? sh * c[n - 1] / eq : 0, won = x => Math.round(x), kn = kj[n - 1];
  return {
    cum: r2((eq / SEED - 1) * 100), pnl: won(eq - SEED), eq: won(eq),
    avg: sh > 0 ? +cost.toFixed(cost >= 1000 ? 0 : 2) : null, pos: w <= 0.001 ? '현금' : `보유 ${Math.round(w * 100)}%`, trades,
    kj: kn == null ? null : +kn.toFixed(kn >= 1000 ? 0 : 2),
    maxRet: r2((hi / SEED - 1) * 100), maxAmt: won(hi - SEED), maxD: hiD,
    maxLoss: r2((lo / SEED - 1) * 100), lossAmt: won(lo - SEED), lossD: loD,
  };
}

export const KJ_STRAT = {
  id: 'KJ', name: '일목기준선', short: '기준선 돌파(양봉·거래량↑) 또는 이틀 연속 위 마감 50% → 기준선 터치 25%×2 → 이탈 전량 매도',
  desc: '기준선(26봉 최고 고가·최저 저가 중간) 기준 매매. 1년까지만 계산 (지지·저항 계산 때 받은 약 1년 2개월 일봉 사용) / '
    + '진입: 전일 종가가 기준선 이하였다가 당일 종가가 기준선 위로 올라선 양봉, 거래량이 직전 30일 평균보다 많으면 종가에 50% 매수. 거래량 돌파가 없어도 기준선 위로 이틀 연속 마감하면 그날 종가에 50% 매수 / '
    + '추가: 보유 중 종가가 기준선 위 3% 이상 벌어졌다가 기준선 +1.5% 이내로 돌아오면 25% 추가 (최대 2번). 기준선 밑 마감이라도 거래량이 30일 평균 이하이고 장대음봉이 아니면 사고, 다음 날 기준선 위 마감에 실패하거나, 회복한 다음 날 다시 기준선 밑으로 마감하면 전량 매도 / '
    + '매도: 기준선 밑 마감이면서 장대음봉(몸통이 20일 평균의 1.5배 이상·−2% 이상) 또는 거래량 30일 평균 초과 → 전량 · 이틀 연속 기준선 밑 마감 → 전량 / '
    + '필터: 돌파는 기준선 +1% 위 마감만 인정. 횡보(10일간 기준선 변화 ±1% 이내 + 20일 동안 종가가 기준선을 3번 이상 넘나듦) 중엔 추가매수 안 하고, 진입은 종가가 최근 20일 최고 종가를 넘을 때만',
};
export const KJ_PERIODS = ['YTD', '1M', '3M', '6M', '1Y'];

/** effect(전략 비교)에 일목기준선 카드를 얹는다 — ohlc 가 시작일을 덮는 기간만 */
export function addKijun(effect, ohlc) {
  if (!effect?.follows || !ohlc?.d?.length) return effect;
  const X = kjPrep(ohlc);
  let any = false;
  for (const k of KJ_PERIODS) {
    const row = effect.follows[k]; if (!row) continue;
    const t0 = ohlc.d.findIndex(x => x >= row.from);
    if (t0 < 31) continue;                                                     // 기준선·30일 거래량 계산에 필요한 앞 기간이 없음
    row.KJ = runKJ(ohlc, X, t0, false); row.KJF = runKJ(ohlc, X, t0, true); any = true;
  }
  if (any) effect.strats = [...(effect.strats || []), { id: KJ_STRAT.id, name: KJ_STRAT.name, short: KJ_STRAT.short, desc: KJ_STRAT.desc }];
  effect.kjMax = '1Y';
  return effect;
}
