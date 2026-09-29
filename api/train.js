// POST /api/train (관리자)
//   {step:'fetch', offset}  라벨 종목 일봉을 6종목씩 준비 (화면이 반복 호출)
//   {step:'fit'}            현재 임계값에 맞춰 확률 Ps 를 보정 (임계값 자체는 신뢰도 기준으로 api/backtest 에서 정함)
import * as store from '../lib/store.js';
import { refresh, isAdmin, send, body, needFrom, engineState } from '../lib/service.js';
import { calibrateFromLabels, classifyOf, score, Series } from '../lib/engine.js';
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
      // 임계값은 이제 신뢰도 기준(api/backtest tune)으로 정한다. 여기서는 현재 임계값에 맞춰 확률 Ps 만 다시 보정하고,
      // DS 라벨 재현율은 '참고 지표'로만 계산한다.
      const eng = await engineState();
      const bars = await store.mgetBars(L.stocks), byKey = {}, series = {};
      L.stocks.forEach((s, i) => { const bb = bars[i]; if (bb?.d?.length > 200) { byKey[`${s.m}:${s.code}`] = bb; series[`${s.m}:${s.code}`] = new Series(bb.d, bb.c, bb.v); } });
      const preds = {}; for (const k in series) preds[k] = classifyOf(series[k], eng.params);
      const rep = score(L, series, preds, true);
      const { cal, anchors } = calibrateFromLabels(L, byKey, eng.params);
      const cur = (await store.get('engine')) || {};
      await store.set('engine', { ...cur, params: eng.params, cal, anchors, trainedAt: new Date().toISOString(),
        fit: { train: +rep.acc.toFixed(4), weight: rep.weight, stocks: Object.keys(series).length, note: 'DS 라벨 재현율은 참고용 — 임계값은 신뢰도 기준으로 정함' } });
      await store.set('train:report', { report: rep.rows, missing: L.stocks.map(x => `${x.m}:${x.code}`).filter(k => !series[k]) });
      return send(res, 200, { params: eng.params, fit: { train: +rep.acc.toFixed(4) }, anchors, calibrated: true });
    }
    send(res, 400, { error: 'step 은 fetch | fit' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
