// 유니버스(S&P500·나스닥100 / 코스피200·코스닥150) 매일 전종목 판정.
// 검색으로 추가하는 내 목록(list)과는 별개 — 여기는 자동으로만 돌고, 화면에는 분포와 '오늘 바뀐 종목'으로 나옴.
import * as store from './store.js';
import { refresh, engineState, KEEP } from './service.js';
import { SEASONS } from './engine.js';
import { analyzeV2 as analyze } from './engine2.js';
import { fetchUniverse } from './masters.js';
import { sectorOf } from './sectors.js';
import { classifyOf } from './engine2.js';
import { Series } from './engine.js';
import { themeMap, loadOvr, rotationOf } from './themes.js';

export const UNIV_SETS = { US: ['SPX', 'NDX'], KR: ['K200', 'KQ150'] };
export const SET_NAME = { SPX: 'S&P 500', NDX: '나스닥 100', K200: '코스피 200', KQ150: '코스닥 150' };
const MEM_KEY = 'univ:members', MEM_TTL = 7 * 864e5;
export const kstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

/** 구성종목 — Redis 에 7일 캐시. 새로 못 받으면 옛 캐시라도 씀 */
export async function members({ force = false } = {}) {
  const cur = await store.get(MEM_KEY);
  if (!force && cur && Date.now() - Date.parse(cur.at) < MEM_TTL) return cur;
  try {
    const got = await fetchUniverse();
    if (!Object.keys(got.sets).length) throw new Error(got.errors.join(' / ') || '구성종목 0');
    await store.set(MEM_KEY, got);
    return got;
  } catch (e) {
    if (cur) return { ...cur, errors: [...(cur.errors || []), `갱신 실패(옛 목록 사용): ${e.message}`] };
    throw e;
  }
}

/** 시장별 대상 종목 — 두 지수를 합치고 중복 제거, 어느 지수에 들었는지 tag 로 표시 */
export function listOf(m, mem) {
  const by = new Map();
  for (const key of UNIV_SETS[m]) for (const x of mem.sets?.[key] || []) {
    const k = x.code, cur = by.get(k);
    if (cur) cur.tags.push(key); else by.set(k, { ...x, tags: [key] });
  }
  return [...by.values()].sort((a, b) => a.code.localeCompare(b.code));
}

const stateKey = m => `univ:state:${m}`, resKey = m => `univ:res:${m}`, prevKey = m => `univ:prev:${m}`;
export const dailyKey = m => `univ:daily:${m}`, histKey = m => `univ:hist:${m}`;

/** 배치 한 번: 남은 종목을 시간 예산만큼 갱신·판정. 끝나면 분포와 국면 변경 목록을 만들어 저장 */
export async function scanBatch(m, { budgetMs = 45000, reset = false } = {}) {
  const t0 = Date.now(), today = kstDate();
  const mem = await members();
  const list = listOf(m, mem);
  if (!list.length) throw new Error(`${m} 구성종목을 못 받았어 — ${(mem.errors || []).join(' / ')}`);
  let st = await store.get(stateKey(m));
  if (reset || !st || st.date !== today) st = { date: today, i: 0, failed: [], startedAt: new Date().toISOString() };
  let res = st.i ? await store.get(resKey(m)) : null;
  if (!res || res.date !== today) res = { date: today, rows: {} };

  const eng = await engineState();
  let n = 0;
  while (st.i < list.length && Date.now() - t0 < budgetMs) {
    const it = list[st.i], item = { m, code: it.code, name: it.name, excd: it.excd || null };
    try {
      const { bars, excd } = await refresh(item);
      const { summary } = analyze(bars, eng.params, eng.cal, KEEP);
      res.rows[it.code] = { n: it.name, t: it.tags.join('+'), x: excd || null, s: summary.season, p: summary.prob,
        e: summary.entry, g: summary.age, d5: summary.ps5, d1: summary.ps1, pv: summary.prev?.s || null, c: summary.last, r: summary.sinceEntry, dd: summary.dd, ld: summary.lastDate };
    } catch (e) {
      st.failed.push({ code: it.code, error: e.message.slice(0, 120) });
      if (st.failed.length > 400) st.failed = st.failed.slice(-400);
    }
    st.i++; n++;
  }
  const done = st.i >= list.length;
  await store.set(resKey(m), res);
  await store.set(stateKey(m), { ...st, done, updatedAt: new Date().toISOString() });
  let daily = null;
  if (done) daily = await finish(m, res, st, list.length);
  return { m, date: today, i: st.i, total: list.length, scanned: n, failed: st.failed.length, done, ms: Date.now() - t0, daily };
}

/** 스캔 완료 — 분포, 전일 대비 국면 변경, 확률 변화 큰 종목 */
async function finish(m, res, st, total) {
  const prev = await store.get(prevKey(m));
  const rows = res.rows, codes = Object.keys(rows);
  // 대부분 실패한 스캔(KIS 장애·토큰 오류 등)으로 어제 결과를 덮어쓰지 않는다 — 전종목 표·분포가 통째로 비는 걸 막음
  if (codes.length < total * 0.5) {
    const old = await store.get(dailyKey(m));
    const warn = { at: new Date().toISOString(), asof: res.date, ok: codes.length, total, failed: st.failed.slice(0, 5) };
    if (old) { await store.set(dailyKey(m), { ...old, lastFail: warn }); return { ...old, lastFail: warn }; }
    return { asof: res.date, m, n: codes.length, total, lastFail: warn, cnt: {}, pct: {} };
  }
  const cnt = Object.fromEntries(SEASONS.map(s => [s, 0]));
  for (const c of codes) cnt[rows[c].s]++;
  const n = codes.length || 1;
  const pct = Object.fromEntries(SEASONS.map(s => [s, +(100 * cnt[s] / n).toFixed(1)]));
  // 국면 변경은 '두 스냅샷의 차이'가 아니라 종목 자신의 국면 이력으로 판정한다.
  //   예전 방식은 어제 저장해 둔 스냅샷과 비교했는데, 그 스냅샷이 며칠 묵었거나(크론 정지) 다른 판정 기준·파라미터로 계산된 것이면
  //   실제로는 오래전부터 같은 국면인 종목이 '오늘 바뀐 종목'으로 잡혔다 → 상세 화면(오늘 데이터로 다시 판정)과 어긋남.
  //   이제는 '현재 국면의 진입일이 직전 스캔의 마지막 봉 이후'인 종목만 변경으로 본다 → 상세 화면의 국면 이력과 항상 일치.
  const changes = [], moves = [];
  const addDays = (d, k) => new Date(Date.parse(d) + k * 864e5).toISOString().slice(0, 10);
  for (const c of codes) {
    const b = rows[c], a = prev?.rows?.[c];
    if (!b.e || !b.ld) continue;
    const since = a?.ld && a.ld < b.ld && a.ld >= addDays(b.ld, -10) ? a.ld : null;     // 직전 스캔이 10일 넘게 묵었으면 마지막 봉 하루만 본다
    const changed = since ? b.e > since : b.e === b.ld;
    if (changed && b.pv && b.pv !== b.s) changes.push({ code: c, name: b.n, tag: b.t, from: b.pv, to: b.s, d: b.e, prob: b.p });
    else if (b.d1 != null && Math.abs(b.d1) >= 10) moves.push({ code: c, name: b.n, tag: b.t, s: b.s, from: Math.round(b.p - b.d1), to: b.p });
  }
  changes.sort((x, y) => SEASONS.indexOf(x.to) - SEASONS.indexOf(y.to) || y.prob - x.prob);
  moves.sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from));
  const bySet = {};
  for (const key of UNIV_SETS[m]) {
    const sub = codes.filter(c => rows[c].t.includes(key));
    if (!sub.length) continue;
    const cc = Object.fromEntries(SEASONS.map(s => [s, sub.filter(c => rows[c].s === s).length]));
    bySet[key] = { n: sub.length, cnt: cc, bull: +(100 * (cc['봄'] + cc['여름']) / sub.length).toFixed(1) };
  }
  const daily = {
    asof: res.date, at: new Date().toISOString(), m, n, total, failed: st.failed.slice(0, 40), failedN: st.failed.length,
    cnt, pct, bull: +(pct['봄'] + pct['여름']).toFixed(1), bySet,
    prevAsof: prev?.date || null, changes: changes.slice(0, 120), changesN: changes.length,
    moves: moves.slice(0, 40), movesN: moves.length,
  };
  await store.set(dailyKey(m), daily);
  await store.set(prevKey(m), { date: res.date, rows });                       // 다음 날 비교 기준
  const hist = (await store.get(histKey(m))) || [];
  const rec = { asof: daily.asof, cnt, pct, bull: daily.bull, n, changes: changes.length };
  await store.set(histKey(m), [...hist.filter(h => h.asof !== rec.asof), rec].slice(-120));
  return daily;
}

/** 스캔 진행 상태 (화면 표시용) */
export async function scanState(m) {
  const [st, daily] = await store.mget([stateKey(m), dailyKey(m)]);
  return { state: st || null, daily: daily || null };
}

/** 시장 전체 섹터 표 {code: 섹터} — 펀더멘털 점수표에 모인 업종 정보 + 직접 정리한 표 + 종목명 규칙 */
export async function sectorMap(m, names = {}) {
  const sum = await store.get(`fund:sum:${m}`), out = {};
  for (const r of sum?.rows || []) if (r.sector) out[r.code] = r.sector;
  for (const [code, name] of Object.entries(names)) if (!out[code]) { const s = sectorOf(m, code, { name }); if (s) out[code] = s; }
  return out;
}

/** 유니버스 전종목 섹터 {code: 섹터} + 세부 업종 — 직접 바꾼 값 우선 */
export async function themesFor(m) {
  const mem = await members(), list = listOf(m, mem), names = Object.fromEntries(list.map(x => [x.code, x.name]));
  const [sec, ovr] = await Promise.all([sectorMap(m, names), loadOvr(m)]);
  return { names, sec, ovr, map: themeMap(m, sec, Object.keys(names), ovr) };
}

/** 섹터 순환 재료를 일봉에서 바로 계산해 저장 — 매일 유니버스 스캔이 끝난 뒤 첫 조회 때 다시 계산 (api/universe ?rot) */
export async function buildRotation(m) {
  const { names, map } = await themesFor(m), eng = await engineState(), codes = Object.keys(names), items = [];
  for (let i = 0; i < codes.length; i += 25) {
    const bars = await store.mget(codes.slice(i, i + 25).map(c => store.barsKey(m, c)));
    bars.forEach((b, k) => {
      if (!b?.d?.length || b.d.length < 120) return;
      const s = new Series(b.d, b.c, b.v), code = codes[i + k];
      items.push({ code, name: names[code], s, season: classifyOf(s, eng.params) });
    });
  }
  const rot = rotationOf(items, map);
  if (rot) await store.set(`mkt:rot:${m}`, rot);
  return rot;
}
