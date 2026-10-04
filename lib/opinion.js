// 종목별 종합 의견 — 국면엔진(추세추종) 점수 + 대장엔진(가치) 점수 + 거래량 신호를 합친다.
//   "겨울이라도 싸고 거래량이 터지면 단기 반등", "여름이라도 비싸고 거래량이 터지면 차익실현 경계"
const SEASON_BASE = { 봄: 56, 여름: 72, 가을: 34, 겨울: 14 };
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

/** 거래량 신호 — 최근 1일·5일이 20일 평균 대비 얼마나 터졌나 */
export function volumeSignal(bars) {
  const v = bars?.v;
  if (!v || v.length < 25) return { ok: false };
  const n = v.length, avg = (a, b) => { let s = 0, c = 0; for (let i = a; i < b; i++) if (v[i] > 0) { s += v[i]; c++; } return c ? s / c : 0; };
  const m20 = avg(n - 20, n), m5 = avg(n - 5, n), last = v[n - 1];
  if (!m20) return { ok: false };
  const vr1 = +(last / m20).toFixed(2), vr5 = +(m5 / m20).toFixed(2);
  return { ok: true, vr1, vr5, surge: vr1 >= 2 || vr5 >= 1.5, dry: vr5 <= 0.6 };
}

/** 저점매수 가점 — 겨울 20일+ · 20일선 −15% 이하이면 추세 점수에 더한다 (깊을수록 조금 더, 최대 +40) */
export const dipBonus = dip => (dip ? Math.round(30 + Math.min(10, Math.max(0, -dip.dev20 - 15) * 0.5)) : 0);

/** 국면엔진 점수 (0~100) — 계절 + 확률 + 정배열 + 고점과의 거리 + 저점매수 가점 → 화면의 '추세+저점' */
export function trendScore(s) {
  if (!s || !s.season) return null;
  let x = SEASON_BASE[s.season] ?? 40;
  if (s.prob != null) x += (s.prob - 50) * 0.2;
  x += 8 * Math.max(-1, Math.min(1, s.align ?? 0));               // 정배열 +8 · 역배열 −8 (혼조는 그 사이)
  if (s.dd != null) x += s.dd > -5 ? 6 : s.dd > -15 ? 2 : s.dd > -30 ? -3 : -8;
  if (s.ps5 != null) x += Math.max(-5, Math.min(5, s.ps5 * 0.4));
  x += dipBonus(s.dip);
  return Math.round(clamp(x));
}

const grade = x => (x == null ? '—' : x >= 80 ? 'A' : x >= 60 ? 'B' : x >= 40 ? 'C' : x >= 20 ? 'D' : 'E');

export const W_TREND = 0.7;                                      // 기본 비율 추세 70 : 가치 30 (화면에서 10단위로 바꿀 수 있음)

/**
 * 종합 의견 판단 — 재료(b)와 추세 비율(wT, 0~1)만으로 정한다. public/index.html 의 judge() 와 같은 식 (화면에서 비율을 바꾸면 거기서 다시 계산).
 *   b = { T, V, val(싼 정도 백분위), peak, surge, dry, vr1, season, dip:{age,dev20}, extra:[펀더멘털 근거] }
 *   가치 비율 0 이면 가치 점수·밸류 백분위·이익 정점 경계를 모두 안 본다. 가치 점수가 없으면 종합 = 추세.
 */
export function judge(b, wT = W_TREND) {
  const wV = 1 - wT, useV = wV > 0.001, V = useV ? b.V : null, val = useV ? b.val : null;
  const C = b.T == null ? null : V == null ? b.T : Math.round(wT * b.T + wV * V);
  const gate = k => (V != null ? C >= k : !useV && b.T != null && b.T >= k);   // 가치 점수 없고 비율이 있으면 통과 못 함 (예전과 같음)
  const cheap = val != null && val >= 65, rich = val != null && val <= 30, peak = useV && !!b.peak, surge = !!b.surge, why = [];
  let stance = '관망', tone = 'hold';
  if (b.season === '여름') {
    if (peak) { stance = '비중 축소 검토'; tone = 'trim'; why.push('추세는 살아 있지만 이익 증가율이 꺾이는 구간 — 정점 통과 신호'); }
    else if (rich && surge) { stance = '차익실현 경계'; tone = 'trim'; why.push(`비싼 구간(밸류 하위 ${val}%)에서 거래량 ${b.vr1}배 — 물량 출회 가능성`); }
    else if (gate(70)) { stance = '핵심 보유'; tone = 'buy'; why.push(useV ? '추세·실적이 같은 방향 — 눌림에서 비중 유지·확대' : '추세 점수 70 이상 — 눌림에서 비중 유지·확대'); }
    else { stance = '보유'; tone = 'hold'; why.push(useV ? '추세는 좋지만 종합 점수가 평범 — 추세가 깨지면 바로 정리' : '추세는 살아 있음 — 추세가 깨지면 바로 정리'); }
  } else if (b.season === '봄') {
    if (cheap || gate(58)) { stance = '선취매 후보'; tone = 'buy'; why.push('바닥을 지나 60일선 위 — 여름 전환 시 초기 진입 자리'); }
    else if (rich) { stance = '관망'; tone = 'hold'; why.push('전환 초기이지만 이미 비싸 — 여름 확인 후 대응'); }
    else { stance = '관찰'; tone = 'hold'; why.push(useV ? '전환 각은 나왔으나 실적 확인 전' : '전환 각은 나왔으나 추세 확인 전'); }
    if (surge) why.push(`거래량 ${b.vr1}배 — 수급이 들어오는 중`);
  } else if (b.season === '가을') {
    if (cheap && gate(48)) { stance = '분할 보유'; tone = 'hold'; why.push('추세는 훼손됐지만 실적·밸류가 받쳐줌 — 분할 대응'); }
    else { stance = '비중 축소'; tone = 'trim'; why.push('고점 대비 이탈 구간 — 반등 시 비중 축소'); }
  } else if (b.season === '겨울') {
    if (b.dip) { stance = '저점매수 후보'; tone = 'trade'; why.push(`겨울 ${b.dip.age}일째 · 20일선 대비 ${b.dip.dev20}% — 저점매수 조건 (60일선 회복·40거래일·매수가 −15% 중 먼저 오면 매도)`); if (cheap) why.push(`밸류도 싼 편 (상위 ${100 - val}%)`); }
    else if (cheap && surge) { stance = '단기 반등 트레이딩'; tone = 'trade'; why.push(`낙폭과대 + 거래량 ${b.vr1}배 — 갭 메우기 단기 대응(손절 폭 좁게)`); }
    else if (cheap) { stance = '바닥 관찰'; tone = 'watch'; why.push('싸지만 아직 수급 신호 없음 — 거래량 터질 때까지 대기'); }
    else { stance = '회피'; tone = 'avoid'; why.push(useV ? '하락 추세 + 밸류 매력 없음' : '하락 추세'); }
  }
  if (useV) why.push(...(b.extra || []));
  if (b.dry && b.season === '겨울') why.push('거래량 마름 — 횡보 지속 구간');
  return { combined: C, stance, tone, why };
}

/**
 * 종합 의견.
 * @param s     analyze 요약 (season, prob, dd, age, sinceEntry, align, ps5, dip)
 * @param fund  대장엔진 행 ({ score, p:{value,accel,...}, flags, fwdPe, gEpsFwd, revUp })
 * @param vol   volumeSignal 결과
 * @param wT    추세 비율 (기본 0.7)
 */
export function opinion(s, fund, vol, wT = W_TREND) {
  const T = trendScore(s), V = fund?.score ?? null, val = fund?.p?.value ?? null, extra = [];
  if (fund?.revUp != null && fund.revUp > 0) extra.push(`최근 추정 EPS 상향 +${fund.revUp}%`);
  if (fund?.fwdPe != null) extra.push(`${fund.peBasis === 'trailing' ? 'PER(실적 기준)' : '선행 PER'} ${fund.fwdPe}배`);
  const base = { T, V, val, peak: !!fund?.flags?.includes('이익 정점 경계'), surge: !!vol?.surge, dry: !!vol?.dry, vr1: vol?.vr1 ?? null,
    season: s?.season || null, dip: s?.dip || null, extra };
  return {
    trend: { score: T, grade: grade(T), season: base.season, age: s?.age ?? null, note: s?.signal || null, dip: base.dip, bonus: dipBonus(base.dip) },
    value: { score: V, grade: grade(V), cheapPct: val, flags: fund?.flags || [], fwdPe: fund?.fwdPe ?? null, gEpsFwd: fund?.gEpsFwd ?? null },
    volume: vol?.ok ? { vr1: vol.vr1, vr5: vol.vr5, surge: vol.surge } : null,
    base, w: wT, ...judge(base, wT),
  };
}
