// GET /api/cron?m=KR|US — Vercel Cron 이 매일 호출 (vercel.json). 목록 종목의 새 일봉만 받아 덧씀
// GET /api/meta          — 엔진 탭: 학습된 파라미터·보정·라벨 재현표 (rewrite → ?op=meta)
// GET /api/health        — 설정 점검, 값은 노출하지 않고 있는지만 (rewrite → ?op=health)
// Hobby 플랜 함수 12개 제한 때문에 세 엔드포인트를 한 함수로 합쳤다. 주소는 그대로다.
import * as store from '../lib/store.js';
import { refresh, send, isAdmin, engineState } from '../lib/service.js';
import { INDICES, refreshIndex } from '../lib/market.js';
import { chain } from '../lib/universe.js';

export default async function handler(req, res) {
  try {
    const op = req.query.op;
    if (op === 'health') {
      return send(res, 200, {
        redis: await store.ping(), kisKey: !!process.env.KIS_APP_KEY, kisSecret: !!process.env.KIS_APP_SECRET,
        adminToken: !!process.env.ADMIN_TOKEN, cronSecret: !!process.env.CRON_SECRET, youAreAdmin: isAdmin(req),
      });
    }
    if (op === 'meta') {
      const [eng, rep] = await Promise.all([engineState(), store.get('train:report')]);
      return send(res, 200, { ...eng, report: rep?.report || [], missing: rep?.missing || [] });
    }

    const okCron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    if (!okCron && !isAdmin(req)) return send(res, 401, { error: 'cron 전용' });
    const m = req.query.m === 'US' ? 'US' : 'KR', t0 = Date.now();
    const items = (await store.listAll()).filter(x => x.m === m);
    const ok = [], failed = [], skipped = [];
    for (const ix of INDICES.filter(x => x.grp === m)) {           // 시장 지수 먼저
      try { const r = await refreshIndex(ix); ok.push(`${ix.code}+${r.added}`); } catch (e) { failed.push({ code: ix.code, error: e.message.slice(0, 160) }); }
    }
    for (const it of items) {
      if (Date.now() - t0 > 50_000) { skipped.push(it.code); continue; }   // 시간 초과 전에 멈춤 → 다음 날 이어서
      try { const r = await refresh(it); ok.push(`${it.code}+${r.added}`); if (r.excd && r.excd !== it.excd) await store.listPut({ ...it, excd: r.excd }); }
      catch (e) { failed.push({ code: it.code, error: e.message.slice(0, 160) }); }
    }
    const rep = { at: new Date().toISOString(), m, ok: ok.length, failed, skipped, ms: Date.now() - t0 };
    rep.universe = await chain(m);                                  // 유니버스(지수 구성종목) 전종목 스캔 시작 — 배치가 스스로 이어서 돎
    await store.set(`cron:${m}`, rep);
    send(res, 200, rep);
  } catch (e) { send(res, 500, { error: e.message }); }
}
