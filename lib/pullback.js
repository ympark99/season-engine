// 눌림매매 — 급등 시그널(기준봉) 뒤 눌림목에서 진입.
// 일봉은 종가·거래량만 있어서(시가·고가·저가 없음) 기준봉 '시가'는 전일 종가로 근사한다.
//
// 시그널(기준봉) — 필수 기준 4개 모두
//   ① 5·10·20일선 정배열(5 > 10 > 20) + 종가가 5일선 위
//   ② 거래량이 직전 20거래일 평균의 2배 이상
//   ③ 종가 +3% 이상 상승 마감
//   ④ 시가총액 3,000억원 이상 (상장주식수 × 그날 종가, 미국은 × 원/달러) — 주식수를 모르면 이 조건은 건너뜀
// 눌림목(진입) — 기준봉 뒤 15거래일 안에서 아래를 모두 만족한 첫날 종가 (기준봉 하나에 한 번만)
//   · 기준봉 이후 최고 종가 대비 −3% ~ −15% 조정 (얕으면 눌림이 아니고, 깊으면 추세 훼손)
//   · 10일선 근처까지 눌림: 종가 ≤ 10일선 × 1.03 (미너비니식 10·20일선 눌림)
//   · 지지: 종가가 20일선 위 + 기준봉 시작가(전일 종가) 위
//   · 거래량 마름: 기준봉 거래량의 50% 이하 + 20일 평균 이하 (매도 물량 소진)
//   · 20일선이 5거래일 전보다 위 (상승 추세 유지)
// 손절가 — 기준봉 시작가(전일 종가)와 진입가 −8%(미너비니 최대 손실 7~8%) 중 높은 값. 종가가 손절가 아래로 마감하면 손절
// 익절 — 진입일 국면이 봄·여름이면 가을·겨울 전환 전까지 보유, 가을·겨울이면 다음 베이스라인(진입가 위 가장 가까운 60·120일선,
//        둘 다 아래면 기준봉 이후 고점)에 종가가 닿으면 매도
// 손익비 = (목표 − 진입가) ÷ (진입가 − 손절가). 목표는 봄·여름 진입이면 기준봉 이후 고점, 가을·겨울 진입이면 위 베이스라인
import { sma } from './engine.js';

/** 시가총액 조건용 {sh, fx} — mcap:{m} 저장값에서 (국내 fx = 1) */
export const mcOpt = (m, MC, code) => ({ sh: MC?.rows?.[code]?.[0] || 0, fx: m === 'US' ? MC?.fx || 0 : 1 });

export const PB = { up: 3, vol: 2, mcap: 3e11, win: 15, dipMin: 3, dipMax: 15, near: 1.03, dry: 0.5, maxLoss: 8 };

/**
 * 종목 하나의 시그널·눌림 진입 기록.
 * @param s Series (p 종가, v 거래량, d 날짜, m5, m20)
 * @param opt { sh: 상장주식수, fx: 원/달러(국내는 1) } — 없으면 시가총액 조건 건너뜀
 * @returns { sig: Int8Array(시그널 날 1), ent: [{t, s, base, hi, stop, dd, rr, tgt}], zone: Int8Array(눌림 조건 충족일 1), m10 }
 */
export function pbScan(s, opt = {}) {
  const P = s.p, V = s.v, n = P.length, m5 = s.m5, m20 = s.m20, m10 = sma(P, 10), m60 = s.m60, m120 = sma(P, 120);
  const vr = s.volRatio();
  const mcOk = t => !(opt.sh > 0 && opt.fx > 0) || opt.sh * P[t] * opt.fx >= PB.mcap;
  const sig = new Int8Array(n), zone = new Int8Array(n), dz = new Float32Array(n), ent = [];
  let act = null;                                                        // 진행 중인 기준봉 { s, base, hi, vs, used }
  for (let t = 25; t < n; t++) {
    // 진행 중인 기준봉의 눌림 확인 (기준봉 다음날부터)
    if (act && t > act.s) {
      if (t - act.s > PB.win || P[t] < act.base) act = null;              // 15거래일 지남 · 기준봉 시작가 이탈 → 실패
      else {
        const dd = 100 * (P[t] / act.hi - 1);
        const ok = dd <= -PB.dipMin && dd >= -PB.dipMax && P[t] <= m10[t] * PB.near && P[t] >= m20[t] && P[t] > act.base
          && V[t] > 0 && V[t] <= PB.dry * act.vs && vr[t] <= 1 && m20[t] > m20[t - 5];
        if (ok) {
          zone[t] = 1; dz[t] = dd;
          if (!act.used) {
            act.used = true;
            const stop = Math.max(act.base, P[t] * (1 - PB.maxLoss / 100));
            const base = [m60[t], m120[t]].filter(x => x > P[t] * 1.005).sort((a, b) => a - b)[0] ?? null;
            ent.push({ t, s: act.s, base: act.base, hi: act.hi, stop, dd: +dd.toFixed(2), line: base, lineK: base == null ? null : base === m60[t] ? 60 : 120 });
          }
        }
        act && (act.hi = Math.max(act.hi, P[t]));
      }
    }
    // 오늘이 새 기준봉인가 (새 기준봉이 나오면 그걸로 갈아탄다)
    const up = P[t - 1] > 0 ? 100 * (P[t] / P[t - 1] - 1) : 0;
    if (m5[t] > m10[t] && m10[t] > m20[t] && P[t] > m5[t] && V[t] > 0 && isFinite(vr[t]) && vr[t] >= PB.vol && up >= PB.up && mcOk(t)) {
      sig[t] = 1;
      act = { s: t, base: P[t - 1], hi: P[t], vs: V[t], used: false };
    }
  }
  return { sig, zone, dz, ent, m10, m60, m120 };
}

/** 진입 기록 하나의 목표가·손익비 (season = 진입일 국면 번호 0봄 1여름 2가을 3겨울) */
export function targetOf(e, px, season) {
  const tgt = season <= 1 ? e.hi : (e.line ?? e.hi);
  const risk = px - e.stop, rr = risk > 0 && tgt > px ? (tgt - px) / risk : 0;
  return { tgt, rr: +rr.toFixed(2) };
}

/** 목록·상세용 요약 — now: 오늘 눌림 조건, pb20: 최근 20거래일 안 마지막 진입 */
export function pbSummary(s, season, opt = {}, k = 20) {
  const n = s.p.length;
  if (n < 30) return { pb: null, pb20: null };
  const R = pbScan(s, opt), last = R.ent[R.ent.length - 1];
  const f = t => s.d[t];
  let pb20 = null;
  if (last && last.t >= n - k) {
    const { tgt, rr } = targetOf(last, s.p[last.t], season[last.t]);
    pb20 = { d: f(last.t), sig: f(last.s), dd: last.dd, px: +s.p[last.t].toFixed(4), stop: +last.stop.toFixed(4), tgt: +tgt.toFixed(4), rr,
      sn: season[last.t], days: n - 1 - last.t, broke: s.p.slice(last.t + 1).some(x => x < last.stop) };
  }
  const now = R.zone[n - 1] ? { dd: +R.dz[n - 1].toFixed(2) } : null;
  return { pb: now, pb20 };
}
