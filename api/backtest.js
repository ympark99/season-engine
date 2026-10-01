// /api/backtest — 국면 신뢰도 측정(사후 정답 대비 정확도 + BM 대비 초과수익)과 임계값 보정. 큰 데이터를 여러 번에 나눠서 진행한다.
//   측정이 끝나면 확률 Ps 도 그 결과로 다시 맞춘다 ('이 판정이 사후에 맞을 확률').
//   GET                     → 저장된 신뢰도·보정 상태 (화면 표시용)
//   GET ?auto=US&secret=..  → 오늘 남은 일감 한 조각 실행 (매일 이어 돌리는 건 /api/cron 파이프라인)
//   POST {step:'run'}       → 신뢰도 측정 한 조각 (수동)
//   POST {step:'tune'}      → 보정 한 판 (수동)
//   POST {step:'apply'}     → 후보 파라미터를 엔진에 적용
//   POST {step:'reset'}     → 진행 상태 초기화
import * as store from '../lib/store.js';
import { engineState, isAdmin, send, body } from '../lib/service.js';
import { prep, mktChunk, statChunk, meansOf, newCells, finalizeCells, spreadOf, HORIZONS } from '../lib/backtest.js';
import { semantics } from '../lib/semantics.js';
import { tuneRound, readyToApply } from '../lib/tuner.js';
import { fitCal } from '../lib/truth.js';
import { members, listOf, kstDate } from '../lib/universe.js';

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
      const sem = semantics(prep(await loadBars(m, st.codes.slice(0, 120))), eng.params, { cal: eng.cal });
      // 확률 Ps 를 사후 정답 대비 실측으로 다시 맞춘다 (시장별로 따로 저장하지 않고 마지막 측정값을 쓴다)
      const cal = { ...fitCal(cells.calb), src: 'truth', m, at: new Date().toISOString() };
      const engRec = (await store.get('engine')) || {};
      await store.set('engine', { ...engRec, cal, calAt: cal.at });
      const rec = { at: new Date().toISOString(), m, date: today, params: eng.params, sem, cal,
        sample: { got: cells.nSym, asked: st.codes.length, universe: st.universe },
        cut: all.span.a && all.span.b ? cutOf(all.span.a, all.span.b) : null,
        all, acc: all.acc, snapshot: { dist: all.snapshot },
        spread: { all: spreadOf(all) }, horizons: st.horizons };
      await store.set('engine:accuracy', rec);
      await store.set(`engine:accuracy:${m}`, rec);
      st.phase = 'done';
    }
  }
  st.updatedAt = new Date().toISOString();
  await store.set(S_STATE, st);
  return { m, date: today, phase: st.phase, i: st.i, total: st.codes.length, scanned: n, done: st.phase === 'done' };
}

/** 자동 진행 한 조각 — 오늘 신뢰도 측정이 안 끝났으면 측정, 끝났으면 보정(하루 4판). more=false 면 오늘 일 끝 */
export async function autoStep(m) {
  const today = kstDate();
  const st = await store.get(S_STATE), tuner = await store.get(S_TUNER);
  const utcDay = new Date().toISOString().slice(0, 10);
  let did = null;
  if (!st || st.date !== today || st.m !== m || st.phase !== 'done') did = { kind: 'run', r: await runChunk(m) };
  else if (!tuner || tuner.at?.slice(0, 10) !== utcDay || (tuner.todayRounds || 0) < 4) {
    const t = await tuneOnce(m);
    t.todayRounds = (tuner?.at?.slice(0, 10) === utcDay ? (tuner.todayRounds || 0) : 0) + 1;
    await store.set(S_TUNER, t);
    did = { kind: 'tune', round: t.round, todayRounds: t.todayRounds, best: t.pool[0]?.avg, cur: t.cur.avg };
  }
  const more = did ? (did.kind === 'run' ? true : did.todayRounds < 4) : false;
  return { m, did, more };
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
  const st = tuneRound(items, prev, { budgetMs, curParams: eng.params, cut: cutOf(span.a, span.b) });
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
      return send(res, 200, await autoStep(req.query.auto));
    }

    if (req.method === 'GET') {
      const m = req.query.m === 'KR' ? 'KR' : req.query.m === 'US' ? 'US' : null;
      const [acc, accM, tuner, st] = await store.mget(['engine:accuracy', m ? `engine:accuracy:${m}` : 'engine:accuracy', S_TUNER, S_STATE]);
      return send(res, 200, { accuracy: accM || acc || null, tuner: tuner || null, progress: st || null });
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
      const cur = (await store.get('engine')) || {};
      await store.set('engine', { ...cur, params: P, tunedAt: new Date().toISOString(), tunedFrom: cur.params || null });
      await store.del(S_STATE, S_ACC, S_CELLS);                       // 파라미터가 바뀌었으니 신뢰도·확률 보정은 다시 측정
      return send(res, 200, { applied: P });
    }
    send(res, 400, { error: 'step 은 run | tune | apply | reset' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
