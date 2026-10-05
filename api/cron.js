// GET /api/cron?m=KR|US         — Vercel Cron 이 매일 호출 (vercel.json). 자동 갱신 파이프라인 한 조각
// GET /api/cron?op=step&m=KR     — 같은 일. 예비 크론이 부르거나 화면에서 수동 진행(&budget=초)
// GET /api/meta                  — 엔진 탭: 현재 파라미터·확률 보정 (rewrite → ?op=meta)
// GET /api/cron?op=est&t=COHR    — 미국 컨센서스 한 종목 바로 조회 (연결 시험용) · t 없이 부르면 전체 갱신(하루 한 번)
// GET /api/cron?op=fwd            — 미국 선행 지표(요약표) 다시 받기 한 번 (7일 지난 종목만, 천천히)
// GET /api/health                — 설정 점검 + 자동 갱신 진행 상황 (rewrite → ?op=health). 값은 노출하지 않음
// Hobby 플랜 함수 12개 제한 때문에 여러 엔드포인트를 한 함수로 합쳤다. 주소는 그대로다.
import * as store from '../lib/store.js';
import { send, isAdmin, engineState } from '../lib/service.js';
import { step, pipeState } from '../lib/pipeline.js';
import { selfBase, chainLog } from '../lib/selfcall.js';
import { searchId, fetchEstimates, summarize, collectEstimates } from '../lib/estimates.js';
import { targetsOf, scoreAll, refreshForward } from './fundamentals.js';

export default async function handler(req, res) {
  try {
    const op = req.query.op;
    if (op === 'health') {
      const [pipe, chain, auth] = await Promise.all([pipeState(), chainLog(), store.get('cron:denied')]);
      return send(res, 200, {
        redis: await store.ping(), kisKey: !!process.env.KIS_APP_KEY, kisSecret: !!process.env.KIS_APP_SECRET,
        adminToken: !!process.env.ADMIN_TOKEN, cronSecret: !!process.env.CRON_SECRET, youAreAdmin: isAdmin(req),
        selfHost: (selfBase() || '').replace(/^https:\/\//, '') || null, protectionBypass: !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        krFundHeaders: !!process.env.KR_FUND_HEADERS,
        pipeline: pipe, chain: (chain || []).slice(0, 12), cronDenied: auth || null,
      });
    }
    if (op === 'fwd') {                                                                 // 미국 선행 지표만 다시 받기 — 하루 600종목·요청 사이 2.5초 제한은 refreshForward 안에서
      if (!(await store.setNX('lock:fwd:US', 1, 290))) return send(res, 200, { busy: true });
      try {
        const r = await refreshForward('US', 200000);
        if (r.got) { const sum = await scoreAll('US'); r.scored = sum.n; }
        return send(res, 200, r);
      } finally { await store.del('lock:fwd:US'); }
    }
    if (op === 'est' && !req.query.t) {                                                  // 미국 컨센서스 전체 갱신 — 하루 한 번만 실제로 받음 (이미 받은 종목은 건너뜀)
      if (!(await store.setNX('lock:est:US', 1, 290))) return send(res, 200, { busy: true });
      try {
        const r = await collectEstimates((await targetsOf('US')).map(x => x.code), { budgetMs: 200000 });
        if (r.got) { const sum = await scoreAll('US'); r.scored = sum.n; }
        return send(res, 200, r);
      } finally { await store.del('lock:est:US'); }
    }
    if (op === 'est') {                                                                  // 미국 컨센서스 연결 시험 — 한 종목만
      const t = String(req.query.t || 'COHR').toUpperCase().slice(0, 10), t0 = Date.now();
      try {
        const id = await searchId(t);
        if (!id) return send(res, 200, { ok: false, t, step: 'id', ms: Date.now() - t0 });
        const ys = (await fetchEstimates([id]))[id] || [], bars = await store.get(store.barsKey('US', t));
        return send(res, 200, { ok: true, t, id, ms: Date.now() - t0, summary: summarize(ys, bars?.c?.at(-1) ?? null) });
      } catch (e) { return send(res, 200, { ok: false, t, error: e.message, status: e.status ?? null, body: e.body ?? null, ms: Date.now() - t0 }); }
    }
    if (op === 'meta') {
      return send(res, 200, await engineState());
    }

    const sec = process.env.CRON_SECRET;
    const okCron = sec && (req.headers.authorization === `Bearer ${sec}` || req.query.secret === sec);
    const m = req.query.m === 'US' ? 'US' : 'KR';
    if (!okCron && !isAdmin(req)) {
      // 크론이 인증에 막히는 경우(CRON_SECRET 미설정 등)를 화면에서 알 수 있게 남긴다
      await store.set('cron:denied', { at: new Date().toISOString(), m, hasSecret: !!sec, hasAuthHeader: !!req.headers.authorization, ua: String(req.headers['user-agent'] || '').slice(0, 40) }).catch(() => {});
      return send(res, 401, { error: 'cron 전용' });
    }
    const from = isAdmin(req) && !okCron ? '수동' : req.query.bk ? `예비 크론 ${req.query.bk}` : '크론';
    const budgetMs = Math.min(240, Math.max(30, +req.query.budget || 240)) * 1000;   // 화면 버튼은 짧게, 크론은 최대 4분
    send(res, 200, await step(m, { from, budgetMs }));
  } catch (e) { send(res, 500, { error: e.message }); }
}
