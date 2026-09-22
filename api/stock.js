// GET /api/stock?m=US&code=VLO — 상세 차트용 2년 시계열 (날짜·종가·국면·Ps)
import * as store from '../lib/store.js';
import { engineState, KEEP, send } from '../lib/service.js';
import { analyze } from '../lib/engine.js';
import { indexParams } from '../lib/market.js';
import { historyOf } from '../lib/history.js';

export default async function handler(req, res) {
  try {
    const { m, code } = req.query;
    const [bars, eng] = await Promise.all([store.getBars(m, code), engineState()]);
    if (!bars) return send(res, 404, { error: '저장된 일봉이 없어' });
    const P = m === 'IX' ? indexParams(bars, eng.params).P : eng.params;   // 지수는 변동성 보정 임계값
    const A = analyze(bars, P, eng.cal, KEEP), { summary, series } = A, history = historyOf(A, eng.cal, KEEP);
    send(res, 200, { summary, series, history, cal: eng.cal, src: bars.src || null });
  } catch (e) { send(res, 500, { error: e.message }); }
}
