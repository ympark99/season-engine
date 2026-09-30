// /api/universe
//   GET                      → 최신 유니버스 국면 분포·오늘 바뀐 종목·진행 상태 (공개)
//   GET ?scan=US&secret=...  → 배치 스캔 1회 (CRON_SECRET 또는 관리자 키) — 매일 이어 돌리는 건 /api/cron 파이프라인이 한다
//   GET ?rows=US             → 전종목 판정 목록 (대시보드 '전종목 보기')
//   POST {m, step:'scan'}    → 배치 스캔 1회 (화면에서 수동 진행), {step:'members', force} → 구성종목 갱신
import * as store from '../lib/store.js';
import { send, body, isAdmin } from '../lib/service.js';
import { scanBatch, scanState, members, UNIV_SETS, SET_NAME } from '../lib/universe.js';

const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query.secret === process.env.CRON_SECRET);

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    const scanM = req.method === 'GET' ? (req.query.scan === 'US' ? 'US' : req.query.scan === 'KR' ? 'KR' : null) : null;

    if (scanM) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      return send(res, 200, await scanBatch(scanM, { budgetMs: 45000 }));
    }

    if (req.method === 'GET' && (req.query.rows === 'US' || req.query.rows === 'KR')) {
      const m = req.query.rows, prev = await store.get(`univ:prev:${m}`);   // 마지막으로 끝난 스캔의 전종목
      return send(res, 200, { m, date: prev?.date || null, rows: prev?.rows || {} });
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
