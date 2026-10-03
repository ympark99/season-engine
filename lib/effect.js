// 국면 효과 — 'N일 후 수익률' 대신 국면이 실제로 하는 일(얼마나 오래, 얼마나 빨리, 위아래 어느 쪽으로)을 보여준다.
//   구간마다: hold(진입일→전환 확인일 거래일 수), mo(월 환산 = 20거래일 복리 속도, 10일 미만은 null),
//            ex(같은 기간 지수 대비 %p), next(다음 국면)
//   계절별: 월 환산은 그 계절에 머문 모든 날을 이어 붙인 복리 속도(짧은 구간이 숫자를 튀게 하지 않음)
//   전략 비교(기간: 연초·3개월·6개월·1년·2년·3년·5년): 봄·여름만 보유 / 봄 진입·가을 매도 / 레버리지 / 생왕쇠사 / 계속 보유
//   fit = 이 종목에 계절이 잘 맞는지 (상세 화면 맨 위 태그)
import { SEASONS } from './engine.js';

const MO = 20, MIN_MO = 10, WARMUP = 60, COST = 0.001;     // 한 달 = 20거래일, 거래비용 회전율 1당 0.1%

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
export function effectOf(A, history, ix, keep = 1265) {
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
  // 전략 비교 — 5년 창 시작일부터 규칙대로 돌린 장부를 기간별(연초·3개월~5년) 시작일에서 잘라 본다 (그 시점 보유 상태 그대로 이어받음)
  const base = Math.max(WARMUP, n - keep);
  const books = Object.fromEntries(STRATS.map(st => [st.id, runStrat(st.id, s, season, base)]));
  const at = N => Math.max(base, n - 1 - N);
  const y0 = s.d[n - 1].slice(0, 4) + '-01-01'; let ty = n - 1; while (ty > base && s.d[ty] >= y0) ty--;
  const PER = [['YTD', '연초', ty], ['3M', '3개월', at(63)], ['6M', '6개월', at(126)], ['1Y', '1년', at(252)], ['2Y', '2년', at(504)], ['3Y', '3년', at(756)], ['5Y', '5년', base]];
  const follows = {};
  for (const [k, , t0] of PER) {
    if (t0 >= n - 1) continue;
    const row = { from: s.d[t0], to: s.d[n - 1], days: n - 1 - t0 };
    for (const st of STRATS) row[st.id] = windowOf(books[st.id], t0 - base, n - 1 - base);
    follows[k] = row;
  }
  const meta = { cost: COST * 100, strats: STRATS.map(({ id, name, short, desc }) => ({ id, name, short, desc })), periods: PER.filter(([k]) => follows[k]).map(([k, l]) => [k, l]) };
  return { seasons, follows, ...meta, fit: fitOf(seasons, follows['5Y'] || follows['3Y'] || null, history) };
}

/* ------------------------------ 전략 비교 ------------------------------ */
// 체결은 국면 판정일(또는 손절선 이탈일) 종가. 거래비용은 거래 금액의 0.1%.
export const STRATS = [
  { id: 'SS', name: '봄·여름만 보유', short: '봄·여름 보유 · 가을·겨울 현금', desc: '봄·여름이면 보유, 가을·겨울이면 현금 (겨울에서 바로 여름이 와도 산다)' },
  { id: 'SF', name: '봄 진입, 가을 매도', short: '봄에만 진입 → 여름 보유 → 가을 전량 매도 → 겨울 관망', desc: '봄 진입 때만 산다 → 여름 보유 → 가을 전량 매도 → 겨울 관망' },
  { id: 'LV', name: '레버리지 전략', short: '봄 진입 → 여름 2배 → 가을 본주 → 겨울 매도', desc: '봄 진입 → 여름 전체 2배 레버리지(여름 구간 수익률 × 2) → 가을 본주로 전환 → 겨울 전량 매도' },
  { id: 'SWS', name: '생왕쇠사', short: '생 40% → 왕 100%(손절선 본전) → 쇠 50% 익절 → 사 청산', desc: '생 파일럿 40%·손절선(사 국면 최저가와 −7% 중 높은 값) → 왕 풀 비중·손절선 본전 → 쇠 50% 익절 → 사 전량 청산' },
  { id: 'H', name: '계속 보유', short: '처음부터 끝까지 보유', desc: '아무것도 안 하고 들고 있기' },
];

/** 규칙 하나를 base 종가부터 끝까지 — 날마다 평가금액 E 배열 (base = 1) */
function runStrat(id, s, season, base) {
  const P = s.p, n = P.length, E = new Float64Array(n - base);
  let cash = 1, sh = 0, cost = 0, stop = 0, stage = 0, half = false;   // stage: 0 없음 · 1 생 파일럿 · 2 왕 풀
  let lev = 0, Es = 0, Ps = 0;                                           // 레버리지: 0 없음 · 1 본주 · 2 여름 2배
  const val = t => cash + sh * P[t];
  const to = (t, w) => {                                                  // 평가금액 대비 비중 w 로 맞춤
    const eq = val(t), cur = sh * P[t], tgt = Math.max(0, w) * eq, d = tgt - cur;
    if (Math.abs(d) < 1e-9) return;
    if (d > 0) { const buy = d / (1 + COST); cost = (sh * cost + buy) / (sh + buy / P[t]); sh += buy / P[t]; cash -= d; }
    else { const q = -d / P[t]; sh -= q; cash += -d * (1 - COST); if (sh < 1e-12) { sh = 0; cost = 0; } }
  };
  const prevLow = t => { const a = runStart(season, t), b = a > 0 ? runStart(season, a - 1) : 0; let lo = Infinity; for (let k = b; k < a; k++) lo = Math.min(lo, P[k]); return isFinite(lo) ? lo : P[t] * 0.93; };
  for (let t = base; t < n; t++) {
    const sn = season[t], entry = t > 0 && season[t] !== season[t - 1];
    if (id === 'LV') {
      // 평가 — 여름 2배는 구간 단순 수익률 × 2 (구간 안에서는 재조정 없음)
      let eq;
      if (lev === 2) eq = Math.max(0, Es * (1 + 2 * (P[t] / Ps - 1)));
      else if (lev === 1) eq = cash + sh * P[t];
      else eq = cash;
      const conv = (mode) => {                                          // mode 0·1·2 로 전환
        if (mode === lev) return;
        const turn = Math.abs(mode - lev);
        eq *= 1 - COST * turn;
        if (mode === 2) { Es = eq; Ps = P[t]; cash = 0; sh = 0; }
        else if (mode === 1) { cash = 0; sh = eq / P[t]; }
        else { cash = eq; sh = 0; }
        lev = mode;
      };
      if (entry || t === base) {
        if (sn === 0 && lev === 0 && entry) conv(1);
        else if (sn === 1 && lev >= 1) conv(2);
        else if (sn === 2 && lev === 2) conv(1);
        else if (sn === 3) conv(0);
      }
      E[t - base] = eq;
      continue;
    }
    if (id === 'H') { if (t === base) to(t, 1); }
    else if (id === 'SS') { if (t === base || entry) to(t, sn <= 1 ? 1 : 0); }
    else if (id === 'SF') {
      if (entry) { if (sn === 0 && sh === 0) to(t, 1); else if (sn >= 2) to(t, 0); }
    } else if (id === 'SWS') {
      // 손절선 이탈 → 즉시 전량 (종가 기준)
      if (sh > 0 && stop > 0 && P[t] < stop) { to(t, 0); stage = 0; half = false; stop = 0; }
      else if (entry) {
        if (sn === 0 && sh === 0) { to(t, 0.4); stage = 1; half = false; stop = Math.max(prevLow(t), P[t] * 0.93); }
        else if (sn === 1) {
          if (sh === 0) { to(t, 1); stage = 2; half = false; stop = P[t] * 0.93; }
          else { to(t, 1); stage = 2; stop = cost; }                    // 불타기 — 풀 비중 + 손절선 본전
        } else if (sn === 2 && sh > 0 && !half) { const eq = val(t); to(t, (sh * P[t] / eq) * 0.5); half = true; }
        else if (sn === 3 && sh > 0) { to(t, 0); stage = 0; half = false; stop = 0; }
      }
    }
    E[t - base] = val(t);
  }
  return E;
}
function runStart(season, t) { let a = t; while (a > 0 && season[a - 1] === season[t]) a--; return a; }

/** 장부를 [i0, i1] 로 잘라 본 성과 — 수익률·최대수익률(시작 대비 최고)·최대손실률(고점 대비 최대 하락) */
function windowOf(E, i0, i1) {
  const e0 = E[i0] || 1e-12;
  let mx = 1, pk = E[i0], mdd = 0;
  for (let i = i0; i <= i1; i++) { const r = E[i] / e0; if (r > mx) mx = r; if (E[i] > pk) pk = E[i]; if (pk > 0) mdd = Math.min(mdd, E[i] / pk - 1); }
  return { cum: r2((E[i1] / e0 - 1) * 100), maxRet: r2((mx - 1) * 100), maxLoss: r2(mdd * 100) };
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
