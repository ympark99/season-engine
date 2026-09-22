// POST /api/train (관리자)
//   {step:'fetch', offset}  라벨 종목 일봉을 6종목씩 준비 (화면이 반복 호출)
//   {step:'fit', samples}   리포트·스크린샷 속 DS 판정을 재현하도록 임계값 학습 → engine 저장
import * as store from '../lib/store.js';
import { refresh, isAdmin, send, body, needFrom } from '../lib/service.js';
import { train } from '../lib/engine.js';
import L from '../lib/labels.js';


export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
  if (!isAdmin(req)) return send(res, 401, { error: '관리자 키가 필요해' });
  try {
    const b = await body(req);
    if (b.step === 'fetch') {
      const off = +b.offset || 0, batch = L.stocks.slice(off, off + 6), done = [], failed = [];
      const fresh = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10);
      const cur = await store.mgetBars(batch);
      for (let i = 0; i < batch.length; i++) {
        const it = batch[i];
        if (cur[i]?.d?.length && cur[i].d[cur[i].d.length - 1] >= fresh && (cur[i].full || cur[i].d[0] <= needFrom())) { done.push(it.code); continue; }
        try { await refresh(it); done.push(it.code); } catch (e) { failed.push({ code: it.code, error: e.message.slice(0, 160) }); }
      }
      const next = off + batch.length;
      return send(res, 200, { done, failed, next, total: L.stocks.length, finished: next >= L.stocks.length });
    }
    if (b.step === 'fit') {
      const bars = await store.mgetBars(L.stocks), byKey = {};
      L.stocks.forEach((s, i) => { if (bars[i]) byKey[`${s.m}:${s.code}`] = bars[i]; });
      const r = train(L, byKey, { samples: Math.min(4000, +b.samples || 2500), folds: 3, seed: +b.seed || 7 });
      await store.set('engine', { params: r.params, cal: r.cal, anchors: r.anchors, trainedAt: r.trainedAt, fit: r.fit });
      await store.set('train:report', { report: r.report, missing: r.missing });
      return send(res, 200, { params: r.params, fit: r.fit, anchors: r.anchors, missing: r.missing });
    }
    send(res, 400, { error: 'step 은 fetch | fit' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
