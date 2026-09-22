// GET /api/market — 시장 지수(나스닥·S&P500·러셀2000·코스피·코스닥) 국면
// 저장된 일봉이 없거나 4일 넘게 묵었으면 그 자리에서 KIS 로 받아옴 (동시 요청은 잠금으로 1번만)
import * as store from '../lib/store.js';
import { engineState, KEEP, send } from '../lib/service.js';
import { analyze } from '../lib/engine.js';
import { INDICES, refreshIndex, indexParams } from '../lib/market.js';
import { historyOf } from '../lib/history.js';

export default async function handler(req, res) {
  try {
    const t0 = Date.now(), eng = await engineState();
    const bars = await store.mgetBars(INDICES.map(x => ({ m: 'IX', code: x.code })));
    const stale = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10), errs = {};
    for (let i = 0; i < INDICES.length; i++) {
      const b = bars[i];
      if (b?.d?.length && b.d[b.d.length - 1] >= stale) continue;
      if (Date.now() - t0 > 40_000) break;
      if (!(await store.setNX(`mkt:lock:${INDICES[i].code}`, 1, 90))) continue;
      try { bars[i] = (await refreshIndex(INDICES[i])).bars; } catch (e) { errs[INDICES[i].code] = e.message; }
      finally { await store.del(`mkt:lock:${INDICES[i].code}`); }
    }
    const out = INDICES.map((ix, i) => {
      const b = bars[i], base = { m: 'IX', code: ix.code, name: ix.name, grp: ix.grp };
      if (!b?.d?.length || b.d.length < 80) return { ...base, error: errs[ix.code] || '아직 데이터 없음' };
      const ip = indexParams(b, eng.params), A = analyze(b, ip.P, eng.cal, KEEP), { summary } = A, history = historyOf(A, eng.cal, KEEP);
      delete summary.events;
      const done = history.filter(h => !h.ongoing);
      const stats = Object.fromEntries(['봄', '여름', '가을', '겨울'].map(s => {
        const xs = done.filter(h => h.s === s);
        return [s, { n: xs.length, avg: xs.length ? +(xs.reduce((a, h) => a + h.rEnd, 0) / xs.length).toFixed(2) : null,
          win: xs.length ? Math.round(100 * xs.filter(h => h.rEnd > 0).length / xs.length) : null,
          days: xs.length ? Math.round(xs.reduce((a, h) => a + h.days, 0) / xs.length) : null }];
      }));
      return { ...base, ...summary, src: b.src?.label || null, scale: { k: ip.k, vol: ip.vol }, stats, recent: history.slice(0, 4), error: errs[ix.code] ? `갱신 실패(이전 값 표시): ${errs[ix.code]}` : undefined };
    });
    send(res, 200, { now: new Date().toISOString(), indices: out });
  } catch (e) { send(res, 500, { error: e.message }); }
}
