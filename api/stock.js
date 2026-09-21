// GET /api/stock?m=US&code=VLO — 상세 차트용 2년 시계열 (날짜·종가·국면·Ps)
import * as store from '../lib/store.js';
import { engineState, KEEP, send } from '../lib/service.js';
import { analyze } from '../lib/engine.js';

export default async function handler(req, res) {
  try {
    const { m, code } = req.query;
    const [bars, eng] = await Promise.all([store.getBars(m, code), engineState()]);
    if (!bars) return send(res, 404, { error: '저장된 일봉이 없어' });
    const { summary, series } = analyze(bars, eng.params, eng.cal, KEEP);
    send(res, 200, { summary, series, cal: eng.cal });
  } catch (e) { send(res, 500, { error: e.message }); }
}
