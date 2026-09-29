// /api/backtest — 국면 신뢰도 측정과 임계값 보정. 큰 데이터를 한 번에 돌리지 않고 여러 번에 나눠서 진행한다.
//   GET                     → 저장된 신뢰도·보정 상태 (화면 표시용)
//   GET ?auto=US&secret=..  → 오늘 남은 일감 한 조각 실행 후 스스로 다음 조각 호출 (cron 체이닝)
//   POST {step:'run'}       → 신뢰도 측정 한 조각 (수동)
//   POST {step:'tune'}      → 보정 한 판 (수동)
//   POST {step:'apply'}     → 후보 파라미터를 엔진에 적용
//   POST {step:'reset'}     → 진행 상태 초기화
import * as store from '../lib/store.js';
import { engineState, isAdmin, send, body } from '../lib/service.js';
import { score, Series } from '../lib/engine.js';
import { classifyOf, calibrateFromLabelsV2 as calibrateFromLabels } from '../lib/engine2.js';
import { prep, mktChunk, statChunk, meansOf, newCells, finalizeCells, spreadOf, distGap, DS_DIST, HORIZONS } from '../lib/backtest.js';
import { semantics } from '../lib/semantics.js';
import { tuneRound, readyToApply } from '../lib/tuner.js';
import { members, listOf, kstDate } from '../lib/universe.js';
import L from '../lib/labels.js';

const S_STATE = 'bt:state', S_ACC = 'bt:acc', S_CELLS = 'bt:cells', S_TUNER = 'engine:tuner';
const CHUNK_MS = 30000;                       // 한 조각에 쓸 시간 (함수 제한 60초 안쪽)
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

/** 유니버스에서 표본 종목 코드 (stride 로 고르게) */
async function sampleCodes(m, want) {
  const mem = await members(), list = listOf(m, mem);
  if (!list.length) throw new Error('구성종목이 없어 — 먼저 유니버스 스캔을 돌려줘');
  const stride = Math.max(1, Math.floor(list.length / want));
  return { codes: list.filter((_, i) => i % stride === 0).slice(0, want).map(x => x.code), universe: list.length };
}
/** 저장된 일봉 묶음 로드 */
async function loadBars(m, codes) {
  const bars = {};
  for (let i = 0; i < codes.length; i += 25) {
    const chunk = codes.slice(i, i + 25), got = await store.mget(chunk.map(c => store.barsKey(m, c)));
    got.forEach((b, j) => { if (b?.d?.length) bars[chunk[j]] = b; });
  }
  return bars;
}
/** DS 라벨 재현율 (보조 지표) */
async function dsLabels() {
  const bars = await store.mgetBars(L.stocks), series = {};
  L.stocks.forEach((s, i) => { const b = bars[i]; if (b?.d?.length > 200) series[`${s.m}:${s.code}`] = new Series(b.d, b.c, b.v); });
  return P => { const preds = {}; for (const k in series) preds[k] = classifyOf(series[k], P); return +score(L, series, preds).toFixed(4); };
}
const cutOf = (a, b) => new Date(Date.parse(a) + (Date.parse(b) - Date.parse(a)) * 0.7).toISOString().slice(0, 10);

/* ------------------------- 신뢰도 측정 (조각 단위) ------------------------- */
async function runChunk(m, { sample = 250, reset = false } = {}) {
  const today = kstDate();
  let st = await store.get(S_STATE);
  if (reset || !st || st.date !== today || st.m !== m) {
    const { codes, universe } = await sampleCodes(m, sample);
    st = { m, date: today, phase: 'mkt', i: 0, codes, universe, horizons: HORIZONS, startedAt: new Date().toISOString() };
    await store.set(S_ACC, {}); await store.set(S_CELLS, null);
  }
  if (st.phase === 'done') return { m, date: today, phase: 'done', i: st.codes.length, total: st.codes.length, scanned: 0, done: true, note: '오늘 측정은 이미 끝났어' };

  const eng = await engineState(), t0 = Date.now();
  let n = 0;
  if (st.phase === 'mkt') {
    const acc = (await store.get(S_ACC)) || {};
    while (st.i < st.codes.length && Date.now() - t0 < CHUNK_MS) {
      const slice = st.codes.slice(st.i, st.i + 20);
      mktChunk(prep(await loadBars(m, slice)), st.horizons, acc);
      st.i += slice.length; n += slice.length;
    }
    await store.set(S_ACC, acc);
    if (st.i >= st.codes.length) { st.phase = 'stat'; st.i = 0; }
  } else if (st.phase === 'stat') {
    const acc = (await store.get(S_ACC)) || {}, means = meansOf(acc, st.horizons);
    let cells = await store.get(S_CELLS);
    if (!cells) cells = newCells(st.horizons);
    while (st.i < st.codes.length && Date.now() - t0 < CHUNK_MS) {
      const slice = st.codes.slice(st.i, st.i + 20);
      statChunk(prep(await loadBars(m, slice)), eng.params, eng.cal, means, cells);
      st.i += slice.length; n += slice.length;
    }
    await store.set(S_CELLS, cells);
    if (st.i >= st.codes.length) {
      const all = finalizeCells(cells);
      const target = m === 'US' ? DS_DIST : null;
      const sem = semantics(prep(await loadBars(m, st.codes.slice(0, 120))), eng.params, { cal: eng.cal });
      const rec = { at: new Date().toISOString(), m, date: today, params: eng.params, sem,
        sample: { got: cells.nSym, asked: st.codes.length, universe: st.universe },
        cut: all.span.a && all.span.b ? cutOf(all.span.a, all.span.b) : null,
        all, snapshot: { dist: all.snapshot, target, gap: target ? distGap(all.snapshot, target) : null },
        spread: { all: spreadOf(all) }, horizons: st.horizons };
      await store.set('engine:accuracy', rec);
      st.phase = 'done';
    }
  }
  st.updatedAt = new Date().toISOString();
  await store.set(S_STATE, st);
  return { m, date: today, phase: st.phase, i: st.i, total: st.codes.length, scanned: n, done: st.phase === 'done' };
}

/* ------------------------------ 보정 한 판 ------------------------------ */
async function tuneOnce(m, { sample = 80, budgetMs = 32000 } = {}) {
  const eng = await engineState();
  const prev = await store.get(S_TUNER);
  const { codes, universe } = await sampleCodes(m, sample * 4);
  const off = ((prev?.off || 0) + sample) % Math.max(1, codes.length);       // 판마다 다른 표본
  const rotated = [...codes.slice(off), ...codes.slice(0, off)];
  const bars = {};                                                           // 일봉이 있는 종목만 sample 개 모을 때까지
  for (let i = 0; i < rotated.length && Object.keys(bars).length < sample; i += 25) {
    Object.assign(bars, await loadBars(m, rotated.slice(i, i + 25)));
  }
  const items = prep(bars).slice(0, sample);
  if (items.length < 25) throw new Error(`일봉이 있는 종목이 ${items.length}개뿐이야 — 유니버스 스캔을 먼저 끝내줘`);
  const span = items.reduce((a, it) => ({ a: !a.a || it.s.d[0] < a.a ? it.s.d[0] : a.a, b: it.s.d[it.s.d.length - 1] > a.b ? it.s.d[it.s.d.length - 1] : a.b }), { a: null, b: '' });
  const dsAccOf = await dsLabels();
  const st = tuneRound(items, dsAccOf, prev, { budgetMs, target: m === 'US' ? DS_DIST : null, curParams: eng.params, cut: cutOf(span.a, span.b) });
  st.m = m; st.off = off; st.sample = { got: items.length, universe }; st.span = span;
  st.ready = readyToApply(st);
  await store.set(S_TUNER, st);
  return st;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    if (req.method === 'GET' && (req.query.auto === 'US' || req.query.auto === 'KR')) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      const m = req.query.auto, today = kstDate();
      const st = await store.get(S_STATE), tuner = await store.get(S_TUNER);
      let did = null;
      if (!st || st.date !== today || st.m !== m || st.phase !== 'done') did = { kind: 'run', r: await runChunk(m) };
      else if (!tuner || tuner.at?.slice(0, 10) !== new Date().toISOString().slice(0, 10) || (tuner.todayRounds || 0) < 4) {
        const t = await tuneOnce(m);
        t.todayRounds = (tuner?.at?.slice(0, 10) === new Date().toISOString().slice(0, 10) ? (tuner.todayRounds || 0) : 0) + 1;
        await store.set(S_TUNER, t);
        did = { kind: 'tune', round: t.round, todayRounds: t.todayRounds, best: t.pool[0]?.avg, cur: t.cur.avg };
      }
      let chained = false, next = null;
      const more = did ? (did.kind === 'run' ? true : did.todayRounds < 4) : false;   // 측정이 끝나면 다음 호출이 보정을 이어서 함
      const host = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
      if (host && process.env.CRON_SECRET) {
        next = more ? `/api/backtest?auto=${m}` : (m === 'US' ? '/api/fundamentals?auto=US' : null);   // 다 끝나면 펀더멘털 수집으로 넘김
        if (next) {
          try { await fetch(`${host}${next}&secret=${encodeURIComponent(process.env.CRON_SECRET)}`, { signal: AbortSignal.timeout(1500) }); chained = true; }
          catch (e) { chained = e.name === 'TimeoutError' || e.name === 'AbortError'; }
        }
      }
      return send(res, 200, { m, did, chained, next });
    }

    if (req.method === 'GET') {
      const [acc, tuner, st] = await store.mget(['engine:accuracy', S_TUNER, S_STATE]);
      return send(res, 200, { accuracy: acc || null, tuner: tuner || null, progress: st || null });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
    if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
    const b = await body(req), m = b.m === 'KR' ? 'KR' : 'US';

    if (b.step === 'reset') { await store.del(S_STATE, S_ACC, S_CELLS); return send(res, 200, { reset: true }); }
    if (b.step === 'run') return send(res, 200, await runChunk(m, { sample: Math.min(500, Math.max(40, +b.sample || 250)), reset: !!b.reset }));
    if (b.step === 'tune') return send(res, 200, await tuneOnce(m, { sample: Math.min(200, Math.max(30, +b.sample || 80)), budgetMs: Math.min(40000, +b.budgetMs || 32000) }));
    if (b.step === 'apply') {
      const t = await store.get(S_TUNER), P = b.params || t?.candidate?.P || t?.pool?.[0]?.P;
      if (!P) return send(res, 400, { error: '적용할 후보가 없어 — 먼저 보정을 돌려줘' });
      const cur = (await store.get('engine')) || {}, bars = await store.mgetBars(L.stocks), byKey = {};
      L.stocks.forEach((s, i) => { if (bars[i]) byKey[`${s.m}:${s.code}`] = bars[i]; });
      const { cal, anchors } = calibrateFromLabels(L, byKey, P);
      await store.set('engine', { ...cur, params: P, cal, anchors, tunedAt: new Date().toISOString(), tunedFrom: cur.params || null });
      await store.del(S_STATE, S_ACC, S_CELLS);                       // 파라미터가 바뀜으니 신뢰도는 다시 측정
      return send(res, 200, { applied: P, anchors: anchors.length });
    }
    send(res, 400, { error: 'step 은 run | tune | apply | reset' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
