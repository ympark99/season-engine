// /api/portfolio — 예시 포트폴리오(엔진 수익률 증명). 진입·청산 모두 종가.
//   GET                      → 저장된 결과
//   GET ?auto=US&secret=..   → 다시 돌려서 저장 (cron 체이닝 끝단)
//   POST {step:'run', m, hold, everyN, years, sample}  (관리자)
import * as store from '../lib/store.js';
import { engineState, isAdmin, send, body } from '../lib/service.js';
import { prep } from '../lib/backtest.js';
import { simulate, buyHold } from '../lib/portfolio.js';
import { members, listOf, kstDate } from '../lib/universe.js';

const KEY = m => `pf:${m}`;
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

async function loadMany(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 25) out.push(...(await store.mget(keys.slice(i, i + 25))));
  return out;
}

async function run(m, { hold = 10, everyN = 5, years = 3, sample = 150 } = {}) {
  const mem = await members(), list = listOf(m, mem);
  if (!list.length) throw new Error('구성종목이 없어 — 유니버스 스캔을 먼저 돌려줘');
  const stride = Math.max(1, Math.floor(list.length / sample));
  const picked = list.filter((_, i) => i % stride === 0).slice(0, sample);
  const bars = await loadMany(picked.map(x => store.barsKey(m, x.code)));
  const byCode = {}, names = {};
  picked.forEach((x, i) => { if (bars[i]?.d?.length) { byCode[x.code] = bars[i]; names[x.code] = x.name; } });
  const items = prep(byCode).map(it => ({ ...it, name: names[it.code] || it.code }));
  if (items.length < 30) throw new Error(`일봉이 있는 종목이 ${items.length}개뿐이야`);

  const fundRows = {};
  if (m === 'US') {
    const recs = await loadMany(items.map(it => `fund:US:${it.code}`));
    recs.forEach((r, i) => { if (r?.rows?.length >= 8) fundRows[items[i].code] = r.rows; });
  }
  const eng = await engineState();
  const r = simulate(items, eng.params, eng.cal, fundRows, { hold, everyN, years });
  r.m = m; r.at = new Date().toISOString(); r.date = kstDate();
  r.fundCovered = Object.keys(fundRows).length;
  r.benchmark = { label: '표본 동일비중 계속 보유', ret: buyHold(items, r.from) };
  r.params = eng.params;
  await store.set(KEY(m), r);
  return r;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    if (req.method === 'GET' && (req.query.auto === 'US' || req.query.auto === 'KR')) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      const r = await run(req.query.auto);
      return send(res, 200, { m: r.m, from: r.from, to: r.to, n: r.n, fundCovered: r.fundCovered, stats: Object.fromEntries(Object.entries(r.strategies).map(([k, v]) => [k, v.stats])) });
    }
    if (req.method === 'GET') {
      const m = req.query.m === 'KR' ? 'KR' : 'US';
      const r = await store.get(KEY(m));
      return send(res, 200, r || { empty: true, m });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
    if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
    const b = await body(req), m = b.m === 'KR' ? 'KR' : 'US';
    if (b.step === 'run') {
      const r = await run(m, { hold: Math.min(30, Math.max(3, +b.hold || 10)), everyN: Math.min(20, Math.max(1, +b.everyN || 5)), years: Math.min(5, Math.max(1, +b.years || 3)), sample: Math.min(300, Math.max(40, +b.sample || 150)) });
      return send(res, 200, { ...r, strategies: Object.fromEntries(Object.entries(r.strategies).map(([k, v]) => [k, { ...v, curve: undefined }])) });
    }
    send(res, 400, { error: "step 은 'run'" });
  } catch (e) { send(res, 500, { error: e.message }); }
}
