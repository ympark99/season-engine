// POST /api/backtest (관리자·cron)
//   {step:'run',   m, sample}      → 현재 파라미터의 국면 신뢰도(BM 대비 초과수익) 측정 → engine:accuracy 저장
//   {step:'tune',  m, sample, n}   → 학습기간에서 旺−死 초과수익 간격을 넓히는 임계값 탐색 → engine:tuned 저장 (검증기간 성적도 같이)
//   {step:'apply'}                 → engine:tuned 의 파라미터를 엔진에 적용 (확률 보정도 DS 앵커로 다시 계산)
import * as store from '../lib/store.js';
import { engineState, isAdmin, send, body } from '../lib/service.js';
import { classify, score, Series, calibrateFromLabels } from '../lib/engine.js';
import { prep, evaluate, spreadOf, snapshotDist, distGap, objective, DS_DIST, HORIZONS } from '../lib/backtest.js';
import { members, listOf } from '../lib/universe.js';
import L from '../lib/labels.js';

const SPACE = { W: [10, 60, 1], b: [0, 0.08], u: [0.03, 0.4], d1: [0.03, 0.15], gap: [0.03, 0.3], TF: [3, 45, 1], TC: [3, 40, 1], vr: [1, 2] };
const toP = x => ({ W: x.W, b: x.b, u: x.u, d1: x.d1, d2: x.d1 + x.gap, TF: x.TF, TC: x.TC, vr: x.vr });
const fromP = P => ({ W: P.W, b: P.b, u: P.u, d1: P.d1, gap: Math.max(0.03, P.d2 - P.d1), TF: P.TF, TC: P.TC, vr: P.vr });
const rng = seed => { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const pick = r => { const x = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = lo + r() * (hi - lo); x[k] = int ? Math.round(v) : v; } return x; };
const near = (x, r, sc) => { const y = {}; for (const [k, [lo, hi, int]] of Object.entries(SPACE)) { const v = Math.min(hi, Math.max(lo, x[k] + gauss(r) * (hi - lo) * sc)); y[k] = int ? Math.round(v) : v; } return y; };
const round = P => Object.fromEntries(Object.entries(P).map(([k, v]) => [k, Number.isInteger(v) ? v : +v.toFixed(5)]));

/** 유니버스에서 표본을 고르고 저장된 일봉을 가져옴 (없는 종목은 건너뜀) */
async function loadSample(m, want) {
  const mem = await members(), list = listOf(m, mem);
  if (!list.length) throw new Error('구성종목이 없어 — 먼저 유니버스 스캔을 돌려줘');
  const stride = Math.max(1, Math.floor(list.length / want));
  const picked = list.filter((_, i) => i % stride === 0).slice(0, want);
  const bars = {};
  for (let i = 0; i < picked.length; i += 25) {
    const chunk = picked.slice(i, i + 25);
    const got = await store.mget(chunk.map(x => store.barsKey(m, x.code)));
    got.forEach((b, j) => { if (b?.d?.length) bars[chunk[j].code] = b; });
  }
  return { bars, asked: picked.length, got: Object.keys(bars).length, universe: list.length };
}

/** DS 라벨(리포트·스크린샷 판정) 재현율 — 엔진 탭의 학습 점수와 같은 지표. 한 번 읽어 여러 파라미터로 재사용 */
async function dsLabels() {
  const bars = await store.mgetBars(L.stocks), series = {}, byKey = {};
  L.stocks.forEach((s, i) => { const b = bars[i]; if (b?.d?.length > 200) { series[`${s.m}:${s.code}`] = new Series(b.d, b.c, b.v); byKey[`${s.m}:${s.code}`] = b; } });
  const acc = P => { const preds = {}; for (const k in series) preds[k] = classify(series[k], P); return +score(L, series, preds).toFixed(4); };
  return { acc, stocks: Object.keys(series).length, byKey };
}

const cutOf = (a, b) => {                       // 학습 70% / 검증 30% 로 날짜를 자름
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return new Date(t0 + (t1 - t0) * 0.7).toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  if (req.method === 'GET') {                       // 저장된 신뢰도·보정 결과 읽기 (화면 표시용)
    const [acc, tuned] = await store.mget(['engine:accuracy', 'engine:tuned']);
    return send(res, 200, { accuracy: acc || null, tuned: tuned || null });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
  const cron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!isAdmin(req) && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
  try {
    const b = await body(req), m = b.m === 'KR' ? 'KR' : 'US', eng = await engineState();

    if (b.step === 'apply') {
      const tuned = await store.get('engine:tuned');
      if (!tuned?.params) return send(res, 400, { error: '적용할 보정 결과가 없어 — 먼저 tune 을 돌려줘' });
      const cur = (await store.get('engine')) || {};
      const barsByKey = {}, bars = await store.mgetBars(L.stocks);
      L.stocks.forEach((s, i) => { if (bars[i]) barsByKey[`${s.m}:${s.code}`] = bars[i]; });
      const { cal, anchors } = calibrateFromLabels(L, barsByKey, tuned.params);
      await store.set('engine', { ...cur, params: tuned.params, cal, anchors, tunedAt: new Date().toISOString(), tunedFrom: tuned.from || null });
      return send(res, 200, { applied: tuned.params, anchors: anchors.length });
    }

    const want = Math.min(400, Math.max(40, +b.sample || 250));
    const { bars, asked, got, universe } = await loadSample(m, want);
    if (got < 30) return send(res, 400, { error: `저장된 일봉이 ${got}종목뿐이야 — 유니버스 스캔을 먼저 끝내줘 (대상 ${universe}종목)` });
    const items = prep(bars);
    const span = items.reduce((a, it) => ({ a: a.a && a.a < it.s.d[0] ? a.a : it.s.d[0], b: a.b > it.s.d[it.s.d.length - 1] ? a.b : it.s.d[it.s.d.length - 1] }), { a: null, b: '' });
    const cut = cutOf(span.a, span.b);

    const target = b.target || (m === 'US' ? DS_DIST : null);

    if (b.step === 'run') {
      const all = evaluate(items, eng.params, { cal: eng.cal });
      const test = evaluate(items, eng.params, { cal: eng.cal, from: cut });
      const snap = snapshotDist(items, eng.params);
      const rec = { at: new Date().toISOString(), m, sample: { asked, got, universe }, params: eng.params, cut,
        all, test, snapshot: { dist: snap, target, gap: target ? distGap(snap, target) : null },
        spread: { all: spreadOf(all), test: spreadOf(test) }, horizons: HORIZONS };
      await store.set('engine:accuracy', rec);
      return send(res, 200, rec);
    }

    if (b.step === 'tune') {
      const t0 = Date.now(), budget = Math.min(48000, +b.budgetMs || 40000), r = rng(+b.seed || 11);
      const ds = await dsLabels();                                     // DS 라벨 재현율도 목적함수에 넣음 (55종목, 가벼움)
      const wDist = b.wDist ?? 0.06, wDs = b.wDs ?? 5;
      const fit = P => {                                               // 학습 구간(70%)에서만 최적화
        const ev = evaluate(items, P, { horizons: [20], to: cut });
        return objective(ev, { dist: snapshotDist(items, P), target, dsAcc: ds.acc(P), wDist, wDs });
      };
      let best = fromP(eng.params), bo = fit(eng.params), tried = 1;
      while (Date.now() - t0 < budget * 0.55) { const x = pick(r), o = fit(toP(x)); tried++; if (o.score > bo.score) { best = x; bo = o; } }
      while (Date.now() - t0 < budget) { const x = near(best, r, 0.10), o = fit(toP(x)); tried++; if (o.score >= bo.score) { best = x; bo = o; } }
      const P = round(toP(best));
      const view = Q => {
        const all = evaluate(items, Q, { cal: eng.cal }), test = evaluate(items, Q, { cal: eng.cal, from: cut });
        const snap = snapshotDist(items, Q);
        return { params: Q, dist: all.dist, snapshot: snap, gap: target ? distGap(snap, target) : null, dsAcc: ds.acc(Q),
          spread: { train: spreadOf(evaluate(items, Q, { to: cut })), test: spreadOf(test), all: spreadOf(all) },
          daily: all.daily, entry: all.entry, prob: all.prob, testDaily: test.daily };
      };
      const rec = { at: new Date().toISOString(), m, cut, tried, sample: { asked, got, universe }, target, weights: { wDist, wDs },
        params: P, from: eng.params, objective: bo, cur: view(eng.params), tuned: view(P) };
      await store.set('engine:tuned', rec);
      return send(res, 200, rec);
    }
    send(res, 400, { error: "step 은 run | tune | apply" });
  } catch (e) { send(res, 500, { error: e.message }); }
}
