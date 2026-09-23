// GET /api/cron?m=KR|US — Vercel Cron 이 매일 호출 (vercel.json). 목록 종목의 새 일봉만 받아 덧씀
import * as store from '../lib/store.js';
import { refresh, send, isAdmin } from '../lib/service.js';
import { INDICES, refreshIndex } from '../lib/market.js';
import { chain } from '../lib/universe.js';


export default async function handler(req, res) {
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
  rep.universe = await chain(m);                                  // 유니버스(지수 구성종목) 전종목 스캔 시작 — 배치가 스스로 이어서 댅
  await store.set(`cron:${m}`, rep);
  send(res, 200, rep);
}
