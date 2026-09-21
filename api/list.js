// GET /api/list — 목록 전체를 판정해서 반환 (가격은 저장된 일봉, 계산은 요청 때마다)
import * as store from '../lib/store.js';
import { engineState, row, send } from '../lib/service.js';
import { SEASONS } from '../lib/engine.js';

export default async function handler(req, res) {
  try {
    const [items, eng, cron] = await Promise.all([store.listAll(), engineState(), store.mget(['cron:KR', 'cron:US'])]);
    const bars = await store.mgetBars(items);
    const stocks = items.map((it, i) => row(it, bars[i], eng));
    const regime = {}, events = [];
    for (const m of ['US', 'KR']) {
      const xs = stocks.filter(s => s.m === m && !s.error);
      const cnt = Object.fromEntries(SEASONS.map(s => [s, xs.filter(x => x.season === s).length]));
      regime[m] = { n: xs.length, cnt, asof: xs.reduce((a, x) => (x.lastDate > a ? x.lastDate : a), '') || null };
    }
    for (const s of stocks) for (const e of s.events || []) events.push({ m: s.m, code: s.code, name: s.name, ...e });
    stocks.forEach(s => delete s.events);
    events.sort((a, b) => (a.d < b.d ? 1 : -1));
    send(res, 200, { now: new Date().toISOString(), engine: { trainedAt: eng.trainedAt, fit: eng.fit }, cron: { KR: cron[0], US: cron[1] }, regime, events, stocks });
  } catch (e) { send(res, 500, { error: e.message }); }
}
