// GET /api/cron?m=KR|US         — Vercel Cron 이 매일 호출 (vercel.json). 자동 갱신 파이프라인 한 조각
// GET /api/cron?op=step&m=KR     — 같은 일. 파이프라인이 스스로 이어 부르거나 예비 크론이 부름
// GET /api/meta                  — 엔진 탭: 학습된 파라미터·보정·라벨 재현표 (rewrite → ?op=meta)
// GET /api/health                — 설정 점검 + 자동 갱신 진행 상황 (rewrite → ?op=health). 값은 노출하지 않음
// Hobby 플랜 함수 12개 제한 때문에 여러 엔드포인트를 한 함수로 합쳤다. 주소는 그대로다.
import * as store from '../lib/store.js';
import { send, isAdmin, engineState } from '../lib/service.js';
import { step, pipeState } from '../lib/pipeline.js';
import { selfBase, chainLog } from '../lib/selfcall.js';

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
    if (op === 'meta') {
      const [eng, rep] = await Promise.all([engineState(), store.get('train:report')]);
      return send(res, 200, { ...eng, report: rep?.report || [], missing: rep?.missing || [] });
    }

    const sec = process.env.CRON_SECRET;
    const okCron = sec && (req.headers.authorization === `Bearer ${sec}` || req.query.secret === sec);
    const m = req.query.m === 'US' ? 'US' : 'KR';
    if (!okCron && !isAdmin(req)) {
      // 크론이 인증에 막히는 경우(CRON_SECRET 미설정 등)를 화면에서 알 수 있게 남긴다
      await store.set('cron:denied', { at: new Date().toISOString(), m, hasSecret: !!sec, hasAuthHeader: !!req.headers.authorization, ua: String(req.headers['user-agent'] || '').slice(0, 40) }).catch(() => {});
      return send(res, 401, { error: 'cron 전용' });
    }
    const from = op === 'step' ? (req.query.bk ? `예비 크론 ${req.query.bk}` : '이어받기') : (isAdmin(req) && !okCron ? '수동' : '크론');
    send(res, 200, await step(m, { from }));
  } catch (e) { send(res, 500, { error: e.message }); }
}
