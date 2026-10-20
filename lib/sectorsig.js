// 섹터 국면 신호 — 4분면(60일 초과수익·탄력)만으로는 꺾임이 1~2주 늦게 보인다. 평균 수익보다 먼저 움직이는 것들을 매일 같이 본다.
//   내부 체력   20일선 위 종목 비율과 그 변화 (평균이 꺾이기 전에 참여 종목부터 준다)
//   대장주      섹터 시가총액 상위 3종목이 20일선을 깨거나 가을·겨울로 넘어갔는지
//   짧은 탄력   5일·10일 초과수익 (20일 창 두 개를 비교하는 탄력보다 빠름)
//   엇갈림      평균은 버티는데 체력이 빠지는 경우 (체력 약화와 겹치면 한 번만 센다)
//   신저가 우위 60일 신저가 종목이 신고가 종목보다 많음
// → 경보 단계(정상·주의·경고·이탈), 진입 신호(주도 확정·선진입), 섹터 점수(0~100).
// 경보는 사유가 SIG.persist 거래일 이어져야 그 단계로 인정한다 (하루짜리 흔들림으로 팔지 않게).
// 기준값(SIG)은 2026-10-20 미국 572·한국 374종목 지난 1년 일봉으로 324개 조합을 비교해 골랐다 (처음 값은 섹터·일의 절반이 경고라 쓸모가 없었음).
//   고른 값: 평소 경고 비율 미국 17%·한국 20% · 소외 전환 전 20거래일 안에 경고 64%·73% (아무 날이나 골랐을 때 40%·42%)
//   · 주도·둔화 섹터에서 경고 이상은 10일 뒤 초과수익이 경고 아래보다 1.0%p 낮음 · 섹터 바꿔 타기 +158%·+137% (4분면만 +139%·+103%)
//   바꿔 타기 수익은 이웃 조합끼리도 크게 출렁여 고르는 기준으로는 덜 믿었다 — 2일 지속·사유 3개 = 경고 구역이 두 시장에서 꾸준했다.
// 2026-10-20 5년(2021-09~2026-10) 재검증: 학습 2021-08~2024-12 · 시험 2025-01~2026-10 으로 나눠 다시 맞춰도 기준값 숫자는 지금 값보다 나은 조합이 없었다
//   (학습·시험 성적 상관 0.1 안팎). 주도 확정은 미국 20일 초과 학습 +1.2%p(t 2.9)·시험 +2.2%p(t 3.5)로 버텼고, 선진입은 2024 한 해만 좋아 끈다.
//   경보는 5년으로 보면 그 뒤 초과수익이 0 근처 — 미국은 이탈 뒤 오히려 앞섰고, 한국 이탈만 시험 기간에 −1.2%p(t −2.0). 섹터순환(S9)은 시장별로 편출 단계를 다르게 둔다.
// 4분면 화면(lib/themes.js rotationOf)·섹터순환 전략(lib/portfolio.js S9)·지난 1년 검증이 모두 이 계산을 쓴다.

export const QN = ['주도', '둔화', '소외', '회복'];                 // 4분면 칸 (시계방향: 회복 → 주도 → 둔화 → 소외)
export const LVL = ['정상', '주의', '경고', '이탈'];
export const SIG_REV = '2026-10-20d';                                   // 기준값·판정 규칙 버전 — 바꾸면 올린다 (저장된 섹터 신호를 다시 계산)
export const SIG = {
  brLow: 45, brDrop: 30, brDiv: 25,          // 체력: 20일선 위 비율 하한 · 10일 새 하락폭 · 엇갈림 하락폭 (%p)
  leadBad: 2,                                // 대장주 3종목 중 몇 개가 무너지면 사유로 칠지
  y10Neg: -3,                                // 단기 탄력: 10일 초과수익 하한 (%p, 5일도 마이너스일 때)
  loMin: 3,                                  // 신저가 우위: 신저가 종목 최소 수
  persist: 2,                                // 경보 인정에 필요한 연속 거래일
  lv2: 3, lv3: 4,                            // 사유 몇 개부터 경고·이탈 (소외 칸에서 경고면 이탈)
  leadBr: 60, earlyBr: 50, earlyRise: 10,    // 진입: 주도 확정 체력 하한 · 선진입 체력 하한·10일 새 상승폭
  early: false,                              // 선진입 신호를 쓸지 — 5년 검증에서 우위 없음 (2024 한 해만 플러스)
  minN: 3,
};

const clip = v => Math.max(-0.7, Math.min(2, v));
const quadOf = (x, y) => (x >= 0 ? (y >= 0 ? 0 : 1) : (y < 0 ? 2 : 3));

/** 종목 한 개의 t 시점 재료. p = 종가, m20 = 20일선, season = 국면(0 봄 · 1 여름 · 2 가을 · 3 겨울), sh = 시가총액 순위용 주식수 */
export function memberAt(p, m20, season, t, sh = 0) {
  if (t < 61 || !(p[t] > 0) || !(p[t - 60] > 0)) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = t - 59; k <= t; k++) { if (p[k] > hi) hi = p[k]; if (p[k] < lo) lo = p[k]; }
  return {
    r60: clip(p[t] / p[t - 60] - 1), r20: clip(p[t] / p[t - 20] - 1), r20p: clip(p[t - 20] / p[t - 40] - 1),
    r10: clip(p[t] / p[t - 10] - 1), r5: clip(p[t] / p[t - 5] - 1), r1: Math.max(-0.5, Math.min(0.5, p[t] / p[t - 1] - 1)),
    up: m20[t] > 0 && p[t] > m20[t], sn: season[t], hi: p[t] >= hi, lo: p[t] <= lo, mc: sh > 0 ? sh * p[t] : 0,
  };
}

/**
 * 하루치 섹터 통계 (신호 판정 전).
 * rows: [{ c, n, keys:[섹터, 묶음…], f: memberAt 결과 }]
 * → { U:{r60,r20,r20p,r10,r5,r1}, S:{ key: {n, x, y, y10, y5, br, bull, hi, lo, ex1, ab1, lead:[{c,n,ok,why}]} } }
 */
export function statsAt(rows, minN = SIG.minN) {
  const U = { r60: 0, r20: 0, r20p: 0, r10: 0, r5: 0, r1: 0 }, by = new Map();
  let n = 0;
  for (const r of rows) {
    if (!r.f) continue;
    n++; for (const k in U) U[k] += r.f[k];
    for (const key of r.keys) { let a = by.get(key); if (!a) by.set(key, (a = [])); a.push(r); }
  }
  if (n < 20) return null;
  for (const k in U) U[k] /= n;
  const S = {};
  for (const [key, xs] of by) {
    const m = xs.length;
    if (m < minN) continue;
    const avg = k => xs.reduce((a, r) => a + r.f[k], 0) / m;
    const lead = [...xs].filter(r => r.f.mc > 0).sort((a, b) => b.f.mc - a.f.mc).slice(0, 3).map(r => {
      const bad = !r.f.up ? '20일선 아래' : r.f.sn >= 2 ? (r.f.sn === 2 ? '가을' : '겨울') : null;
      return { c: r.c, n: r.n, ok: !bad, why: bad };
    });
    S[key] = {
      n: m, x: 100 * (avg('r60') - U.r60), y: 100 * ((avg('r20') - U.r20) - (avg('r20p') - U.r20p)),
      y10: 100 * (avg('r10') - U.r10), y5: 100 * (avg('r5') - U.r5),
      br: 100 * xs.filter(r => r.f.up).length / m, bull: 100 * xs.filter(r => r.f.sn <= 1).length / m,
      hi: xs.filter(r => r.f.hi).length, lo: xs.filter(r => r.f.lo).length,
      ex1: 100 * (avg('r1') - U.r1), ab1: 100 * avg('r1'), lead,
    };
  }
  return { U, S };
}

const pr = (arr, v) => { let b = 0, e = 0; for (const a of arr) { if (a < v) b++; else if (a === v) e++; } return arr.length > 1 ? (b + (e - 1) / 2) / (arr.length - 1) : 0.5; };

/**
 * 하루치 사유 판정 (경보 단계 확정 전) — 오늘 통계 + 5일 전·10일 전 통계.
 * → { key: {...통계, q, brChg5, brChg10, raw(사유 개수로 본 단계), why[], base(점수 바탕)} }
 */
export function judge(now, p5, p10, P = SIG) {
  if (!now) return null;
  const S = now.S, keys = Object.keys(S), out = {};
  const xs = keys.map(k => S[k].x), ys = keys.map(k => S[k].y), y10s = keys.map(k => S[k].y10), brs = keys.map(k => S[k].br);
  for (const k of keys) {
    const s = S[k], q = quadOf(s.x, s.y), b5 = p5?.S?.[k]?.br, b10 = p10?.S?.[k]?.br;
    const brChg5 = b5 == null ? null : s.br - b5, brChg10 = b10 == null ? null : s.br - b10, why = [];
    const f0 = v => Math.round(v);
    const weak = s.br <= P.brLow || (brChg10 != null && brChg10 <= -P.brDrop && s.br < P.leadBr);
    if (weak) why.push(`체력 약화 — 20일선 위 ${f0(s.br)}%${brChg10 != null ? ` (10일 전 ${f0(b10)}%)` : ''}`);
    const lb = s.lead.filter(l => !l.ok);
    if (s.lead.length >= Math.min(P.leadBad, 2) && lb.length >= Math.min(P.leadBad, s.lead.length)) why.push(`대장주 이탈 — ${lb.map(l => `${l.n || l.c} ${l.why}`).join(', ')}`);
    if (s.y10 < P.y10Neg && s.y5 < 0) why.push(`단기 탄력 꺾임 — 10일 초과 ${s.y10.toFixed(1)}%p · 5일 ${s.y5.toFixed(1)}%p`);
    if (!weak && s.x > 0 && s.y10 >= 0 && brChg10 != null && brChg10 <= -P.brDiv) why.push(`엇갈림 — 평균은 버티는데 체력 ${f0(brChg10)}%p`);
    if (s.lo > s.hi && s.lo >= P.loMin) why.push(`신저가 우위 — 60일 신저가 ${s.lo} · 신고가 ${s.hi}`);
    const c = why.length;
    let raw = c >= P.lv3 ? 3 : c >= P.lv2 ? 2 : c >= 1 ? 1 : 0;
    if (q === 2 && raw >= 2) raw = 3;
    const base = 100 * (pr(xs, s.x) + pr(ys, s.y) + pr(y10s, s.y10) + pr(brs, s.br)) / 4;
    out[k] = { ...s, q, brChg5, brChg10, raw, why, base };
  }
  return out;
}

/**
 * 경보 단계 확정 + 진입 신호·점수. seq[0] = 오늘 judge 결과, seq[1] = 하루 전 … (persist 일만큼).
 * 단계 = 최근 persist 거래일 사유 단계 중 가장 낮은 값 (이어진 만큼만 인정).
 */
export function finalize(seq, P = SIG) {
  const j = seq[0];
  if (!j) return null;
  const out = {};
  for (const [k, s] of Object.entries(j)) {
    let lvl = s.raw;
    for (let d = 1; d < P.persist; d++) { const o = seq[d]?.[k]; if (o) lvl = Math.min(lvl, o.raw); }
    let ent = null;
    if (s.q === 0 && s.br >= P.leadBr && s.y10 > 0 && s.raw <= 1) ent = '주도 확정';
    else if (P.early && s.q === 3 && s.y10 > 0 && s.br >= P.earlyBr && s.brChg10 != null && s.brChg10 >= P.earlyRise && s.raw === 0) ent = '선진입';
    out[k] = { ...s, lvl, ent, score: Math.max(0, Math.min(100, Math.round(s.base - 8 * lvl))) };
  }
  return out;
}

const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

/** 화면·저장용으로 줄인 오늘 신호 */
export function slim(j, grp = {}) {
  const out = {};
  for (const [k, s] of Object.entries(j || {})) out[k] = {
    n: s.n, q: s.q, x: r1(s.x), y: r1(s.y), y10: r1(s.y10), y5: r1(s.y5), br: Math.round(s.br), brChg5: s.brChg5 == null ? null : Math.round(s.brChg5),
    brChg10: s.brChg10 == null ? null : Math.round(s.brChg10), bull: Math.round(s.bull), hi: s.hi, lo: s.lo, lead: s.lead,
    lvl: s.lvl, raw: s.raw, why: s.why, ent: s.ent, score: s.score, ...(grp[k] ? { grp: 1 } : {}),
  };
  return out;
}

/**
 * 하루치 통계를 과거까지 한꺼번에 (기준값과 무관한 부분 — 기준값을 바꿔 가며 검증할 때 다시 쓰려고 나눔).
 * items: [{ code, name, s: Series, season }] · thMap {code: 섹터} · groups {묶음: [섹터…]} · sh {code: 주식수}
 */
export function prepSnaps(items, thMap, groups = {}, sh = {}, { val = 250 } = {}) {
  const cnt = new Map();
  for (const x of items) { const d = x.s.d; if (d.length) cnt.set(d[d.length - 1], (cnt.get(d[d.length - 1]) || 0) + 1); }
  const D0 = [...cnt.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0];
  if (!D0) return null;
  const gOf = {}; for (const [g, ts] of Object.entries(groups)) for (const t of ts) (gOf[t] || (gOf[t] = [])).push(g);
  const grpKeys = Object.fromEntries(Object.keys(groups).map(g => [g, 1]));
  const mem = [];
  let dates = null, refLen = 0;
  for (const x of items) {
    const n = x.s.p.length; let i = n - 1;
    while (i > n - 6 && i > 0 && x.s.d[i] > D0) i--;
    if (x.s.d[i] !== D0) continue;
    const th = thMap[x.code] || '기타';
    if (th === '기타') continue;
    mem.push({ x, i0: i, c: x.code, n: x.name, keys: [th, ...(gOf[th] || [])], sh: sh[x.code] || 0 });
    if (i + 1 > refLen) { refLen = i + 1; dates = x.s.d; }
  }
  if (mem.length < 20 || !dates) return null;
  const OFF = Math.min(val + 40, refLen - 62);                       // 계산할 과거 거래일 수 (5·10일 전 비교·경보 지속 + 20일 앞 수익 포함)
  const snap = [];
  for (let off = 0; off <= OFF; off++) {
    snap.push(statsAt(mem.map(r => ({ c: r.c, n: r.n, keys: r.keys, f: r.i0 - off >= 61 ? memberAt(r.x.s.p, r.x.s.m20, r.x.season, r.i0 - off, r.sh) : null }))));
  }
  return { D0, n: mem.length, snap, grpKeys, dOf: off => dates[refLen - 1 - off] };
}

/** 기준값 P 로 매일 신호 (J[0] = 오늘) */
export function judgeAll(prep, P = SIG) {
  const { snap } = prep, raw = [];
  for (let off = 0; off + 10 < snap.length; off++) raw.push(judge(snap[off], snap[off + 5], snap[off + 10], P));
  const J = [];
  for (let off = 0; off + P.persist - 1 < raw.length; off++) J.push(finalize(raw.slice(off, off + P.persist), P));
  return J;
}

/** 오늘 신호 + 최근 기록 + 지난 1년 검증 */
export function sectorSignals(items, thMap, groups = {}, sh = {}, { hist = 60, val = 250, P = SIG } = {}) {
  const prep = prepSnaps(items, thMap, groups, sh, { val });
  if (!prep) return null;
  const J = judgeAll(prep, P);
  if (!J[0]) return null;
  const { dOf, grpKeys } = prep;

  // 최근 기록 (오래된 → 최근): [점수, 경보, 칸, 체력, 그날 초과수익]
  const H = Math.min(hist, J.length), keys = Object.keys(J[0]), sec = {};
  for (const k of keys) {
    const h = [];
    for (let off = H - 1; off >= 0; off--) { const s = J[off]?.[k]; h.push(s ? [s.score, s.lvl, s.q, Math.round(s.br), r1(s.ex1)] : null); }
    let qd = 0; for (let off = 0; off < J.length && J[off]?.[k]?.q === J[0][k].q; off++) qd++;
    let ld = null; if (J[0][k].lvl >= 1) { let off = 0; while (off + 1 < J.length && (J[off + 1]?.[k]?.lvl ?? 0) >= 1) off++; ld = dOf(off); }
    sec[k] = { ...slim({ [k]: J[0][k] }, grpKeys)[k], qDays: qd, lvlSince: ld, h };
  }
  return { asof: prep.D0, n: prep.n, P, dates: Array.from({ length: H }, (_, k) => dOf(H - 1 - k)), sec, val: validate(J, prep) };
}

/** 지난 1년 검증 — 신호가 난 날 뒤 10·20거래일 섹터 초과수익, 소외 전환 전에 경고가 며칠 먼저 떴는지, 섹터 바꿔 타기 시뮬레이션 */
export function validate(J, { snap, dOf, grpKeys }) {
  const L = J.length;
  if (L < 60) return null;
  const keys = Object.keys(J[0]), solo = keys.filter(k => !grpKeys[k]);
  const fwd = (k, off, h) => { if (off - h < 0) return null; let a = 0; for (let o = off - 1; o >= off - h; o--) { const s = snap[o]?.S?.[k]; if (!s) return null; a += s.ex1; } return a; };
  const cls = {}, add = (c, v10, v20) => { const z = cls[c] || (cls[c] = { n: 0, s10: 0, w10: 0, n20: 0, s20: 0, w20: 0 }); if (v10 != null) { z.n++; z.s10 += v10; if (v10 > 0) z.w10++; } if (v20 != null) { z.n20++; z.s20 += v20; if (v20 > 0) z.w20++; } };
  for (let off = 20; off < L; off++) for (const k of solo) {
    const s = J[off]?.[k]; if (!s) continue;
    const v10 = fwd(k, off, 10), v20 = fwd(k, off, 20);
    add('칸:' + QN[s.q], v10, v20);
    if (s.ent) add('신호:' + s.ent, v10, v20);
    add('경보:' + LVL[s.lvl], v10, v20);
    if (s.q <= 1) add('주도·둔화 칸:' + (s.lvl >= 2 ? '경고 이상' : '경고 아래'), v10, v20);
  }
  const classes = Object.fromEntries(Object.entries(cls).map(([c, z]) => [c, { n: z.n, f10: z.n ? r1(z.s10 / z.n) : null, w10: z.n ? Math.round(100 * z.w10 / z.n) : null,
    f20: z.n20 ? r1(z.s20 / z.n20) : null, w20: z.n20 ? Math.round(100 * z.w20 / z.n20) : null }]));

  // 소외 전환 — 직전 20거래일 안에 주도·둔화였던 섹터가 소외 칸에 들어간 날. 그 전에 경고(2단계 이상)가 처음 뜬 날까지 거리
  const W = 20, ev = [];
  for (const k of keys) for (let off = L - 2; off >= 0; off--) {
    const s = J[off]?.[k], pv = J[off + 1]?.[k];
    if (!s || !pv || s.q !== 2 || pv.q === 2) continue;
    let was = false; for (let o = off + 1; o <= Math.min(L - 1, off + W); o++) if (J[o]?.[k] && J[o][k].q <= 1) { was = true; break; }
    if (!was) continue;
    let first = null; for (let o = Math.min(L - 1, off + W); o >= off; o--) if ((J[o]?.[k]?.lvl ?? 0) >= 2) { first = o; break; }
    let w1 = null; for (let o = Math.min(L - 1, off + W); o >= off; o--) if ((J[o]?.[k]?.lvl ?? 0) >= 1) { w1 = o; break; }
    ev.push({ k, grp: grpKeys[k] ? 1 : 0, d: dOf(off), warn: first == null ? null : dOf(first), lead: first == null ? null : first - off, lead1: w1 == null ? null : w1 - off });
  }
  ev.sort((a, b) => (a.d < b.d ? 1 : -1));
  // 비교 기준 — 아무 주도·둔화 섹터·일을 골라도 앞 20거래일 안에 경고가 한 번이라도 있었을 비율
  let wn = 0, wd = 0, bn = 0, bd = 0;
  for (let off = 0; off < L; off++) for (const k of solo) {
    const s = J[off]?.[k]; if (!s) continue;
    wd++; if (s.lvl >= 2) wn++;
    if (s.q <= 1 && off + W < L) { bd++; for (let o = off + 1; o <= off + W; o++) if ((J[o]?.[k]?.lvl ?? 0) >= 2) { bn++; break; } }
  }
  const se = ev.filter(e => !e.grp), early = se.filter(e => e.lead != null && e.lead > 0), lds = early.map(e => e.lead).sort((a, b) => a - b);

  // 섹터 바꿔 타기 — 매일 종가에 고르고 다음 날 수익 (거래비용 없음, 같은 비중)
  const sim = (pick) => { let eq = 1, pk = 1, mdd = 0, turn = 0; const curve = []; let held = [];
    for (let off = L - 1; off >= 1; off--) {
      const nh = pick(J[off], held);
      turn += nh.filter(k => !held.includes(k)).length; held = nh;
      const nx = snap[off - 1]?.S, U = snap[off - 1]?.U;
      const r = held.length ? held.reduce((a, k) => a + (nx?.[k]?.ab1 ?? 0), 0) / held.length / 100 : (U ? U.r1 : 0);
      eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1);
      if (off % 5 === 1 || off === 1) curve.push(Math.round(1000 * (eq - 1)) / 10);
    }
    return { ret: r1(100 * (eq - 1)), mdd: r1(100 * mdd), turn, curve }; };
  const pickNew = (j, held) => {
    if (!j) return held;
    const keep = held.filter(k => j[k] && j[k].lvl < 2);
    const add = solo.filter(k => j[k]?.ent && j[k].lvl <= 1 && !keep.includes(k)).sort((a, b) => j[b].score - j[a].score);
    return [...keep, ...add].slice(0, 3);
  };
  const pickOld = j => (j ? solo.filter(k => j[k]?.q === 0).sort((a, b) => j[b].x - j[a].x).slice(0, 3) : []);
  const strat = { new: sim(pickNew), old: sim(pickOld), univ: sim(() => []) };

  // 신호가 처음 뜬 날만 한 사례로 (같은 섹터에서 10거래일 안에 다시 뜬 건 같은 사례) — 섹터·일로 세면 이어진 날이 겹쳐 표본이 부풀어 보인다
  const ONSET = [
    ['신호:주도 확정', s => s.ent === '주도 확정'], ['칸:주도 진입', s => s.q === 0],
    ['신호:선진입', s => s.ent === '선진입'], ['칸:회복 진입', s => s.q === 3],
    ['경보:경고 이상', s => s.lvl >= 2], ['경보:주도·둔화에서 경고', s => s.lvl >= 2 && s.q <= 1], ['경보:이탈', s => s.lvl === 3],
    ['칸:둔화 진입', s => s.q === 1], ['칸:소외 진입', s => s.q === 2],
  ];
  const st = a => { const n = a.length; if (!n) return null; const m = a.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1));
    return { n, avg: r1(m), win: Math.round(100 * a.filter(v => v > 0).length / n), t: sd > 0 ? r1(m / (sd / Math.sqrt(n))) : null }; };
  const onsets = {};
  for (const [name, f] of ONSET) {
    const a10 = [], a20 = [];
    for (const k of solo) {
      let last = 1e9;
      for (let off = L - 2; off >= 20; off--) {
        const s = J[off]?.[k], p = J[off + 1]?.[k];
        if (!s || !p || !f(s) || f(p)) continue;
        if (last - off >= 10) { const v10 = fwd(k, off, 10), v20 = fwd(k, off, 20); if (v10 != null) a10.push(v10); if (v20 != null) a20.push(v20); }
        last = off;
      }
    }
    onsets[name] = { f10: st(a10), f20: st(a20) };
  }
  return { from: dOf(L - 1), to: dOf(0), days: L, classes, onsets, events: ev.slice(0, 40), evN: se.length, earlyN: early.length,
    leadMed: lds.length ? lds[lds.length >> 1] : null, warnRate: wd ? Math.round(100 * wn / wd) : null, baseWin: bd ? Math.round(100 * bn / bd) : null, strat };
}

/**
 * 전략실(S9)용 — 그날 각 종목 위치(idx)에서 바로 섹터 신호를 계산 (5·10일 전 비교·경보 지속 포함).
 * items: [{ code, name, theme, s, season, sh }] · idxOf(item) → 그날 봉 인덱스
 */
export function sectorDay(items, idxOf, groups = {}, P = SIG) {
  const gOf = {}; for (const [g, ts] of Object.entries(groups)) for (const t of ts) (gOf[t] || (gOf[t] = [])).push(g);
  const base = items.map(x => { const i = idxOf(x), th = x.theme || '기타'; return i == null || i < 0 || th === '기타' ? null : { x, i, keys: [th, ...(gOf[th] || [])] }; });
  const memo = new Map(), at = off => {
    if (!memo.has(off)) memo.set(off, statsAt(base.map((b, k) => (b ? { c: b.x.code, n: b.x.name, keys: b.keys, f: b.i - off >= 61 ? memberAt(b.x.s.p, b.x.s.m20, b.x.season, b.i - off, b.x.sh) : null }
      : { c: items[k].code, n: items[k].name, keys: [], f: null }))));
    return memo.get(off);
  };
  const seq = []; for (let d = 0; d < P.persist; d++) seq.push(judge(at(d), at(d + 5), at(d + 10), P));
  return finalize(seq, P);
}
