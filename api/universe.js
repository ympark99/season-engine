// /api/universe
//   GET                      → 최신 유니버스 국면 분포·오늘 바뀐 종목·진행 상태 (공개)
//   GET ?scan=US&secret=...  → 배치 스캔 1회 (cron 체이닝용, CRON_SECRET 또는 관리자 키)
//   POST {m, step:'scan'}    → 배치 스캔 1회 (화면에서 수동 진행), {step:'members', force} → 구성종목 갱신
import * as store from '../lib/store.js';
import { send, body, isAdmin } from '../lib/service.js';
import { scanBatch, scanState, members, chain, chainBacktest, UNIV_SETS, SET_NAME } from '../lib/universe.js';

const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query.secret === process.env.CRON_SECRET);

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    const scanM = req.method === 'GET' ? (req.query.scan === 'US' ? 'US' : req.query.scan === 'KR' ? 'KR' : null) : null;

    if (scanM) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      const r = await scanBatch(scanM, { budgetMs: 45000 });
      if (!r.done && r.scanned > 0) r.chained = await chain(scanM);
      if (r.done) r.backtest = await chainBacktest(scanM);      // 스캔 완료 → 신뢰도 재측정
      return send(res, 200, r);
    }

    if (req.method === 'POST') {
      if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
      const b = await body(req);
      const m = b.m === 'KR' ? 'KR' : 'US';
      if (b.step === 'members') {
        const mem = await members({ force: !!b.force });
        return send(res, 200, { at: mem.at, errors: mem.errors || [], counts: Object.fromEntries(Object.entries(mem.sets || {}).map(([k, v]) => [k, v.length])) });
      }
      if (b.step === 'scan') return send(res, 200, await scanBatch(m, { budgetMs: +b.budgetMs || 45000, reset: !!b.reset }));
      return send(res, 400, { error: "step 은 scan | members" });
    }

    const [us, kr, mem, acc] = await Promise.all([scanState('US'), scanState('KR'), store.get('univ:members'), store.get('engine:accuracy')]);
    const counts = Object.fromEntries(Object.entries(mem?.sets || {}).map(([k, v]) => [k, v.length]));
    send(res, 200, {
      now: new Date().toISOString(), sets: UNIV_SETS, setName: SET_NAME,
      members: { at: mem?.at || null, counts, errors: mem?.errors || [] },
      US: us, KR: kr, accuracy: acc || null,
    });
  } catch (e) { send(res, 500, { error: e.message }); }
}
