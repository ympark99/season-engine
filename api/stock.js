// GET /api/stock?m=US&code=VLO — 상세 차트용 시계열 (날짜·종가·국면·Ps) + 국면 변경 내역 + 대장 점수·종합 의견
// 내 목록에 없는 종목(유니버스·펀더멘털 표에서 누른 종목)도 저장된 일봉이 있으면 똑같이 보여준다.
import * as store from '../lib/store.js';
import { engineState, KEEP, send } from '../lib/service.js';
import { analyzeV2 as analyze } from '../lib/engine2.js';
import { indexParams } from '../lib/market.js';
import { historyOf } from '../lib/history.js';
import { opinion, volumeSignal } from '../lib/opinion.js';
import { sectorOf } from '../lib/sectors.js';

export default async function handler(req, res) {
  try {
    const { m, code } = req.query;
    const [bars, eng, sum, rec] = await Promise.all([store.getBars(m, code), engineState(), m === 'IX' ? null : store.get(`fund:sum:${m}`), m === 'KR' ? store.get(`fund:KR:${code}`) : null]);
    if (!bars) return send(res, 404, { error: '저장된 일봉이 없어' });
    const P = m === 'IX' ? indexParams(bars, eng.params).P : eng.params;   // 지수는 변동성 보정 임계값 (v2 는 그대로)
    const A = analyze(bars, P, eng.cal, KEEP), { summary, series } = A, history = historyOf(A, eng.cal, KEEP);
    const fund = sum?.rows?.find(r => r.code === code) || null;
    const view = m === 'IX' ? null : opinion(summary, fund, volumeSignal(bars));
    const sector = m === 'IX' ? null : fund?.sector || sectorOf(m, code, { name: req.query.name || null });
    send(res, 200, { summary, series, history, cal: eng.cal, src: bars.src || null, sector,
      fund: fund ? { ...fund, rank: sum.rows.indexOf(fund) + 1, of: sum.n, at: sum.at } : null, view,
      est: rec?.kr ? { yearly: rec.kr.yearly, quarterly: rec.kr.quarterly, at: rec.at } : null });
  } catch (e) { send(res, 500, { error: e.message }); }
}
