// GET /api/stock?m=US&code=VLO — 상세 차트용 시계열 (날짜·종가·국면·Ps) + 국면 변경 내역 + 대장 점수·종합 의견
// 내 목록에 없는 종목(유니버스·펀더멘털 표에서 누른 종목)도 저장된 일봉이 있으면 똑같이 보여준다.
// effect = 국면 효과(계절별 월 환산·위아래 폭·다음 국면, 따라 했다면 3종) + 유니버스 같은 계절 기준선(mkt:eff:{m})
import * as store from '../lib/store.js';
import { engineState, KEEP, send } from '../lib/service.js';
import { analyzeV2 as analyze } from '../lib/engine2.js';
import { indexParams } from '../lib/market.js';
import { historyOf } from '../lib/history.js';
import { effectOf } from '../lib/effect.js';
import { Series } from '../lib/engine.js';
import { opinion, volumeSignal } from '../lib/opinion.js';
import { sectorOf } from '../lib/sectors.js';
import { loadSecOvr } from '../lib/themes.js';
import { mcapOf } from '../lib/mcap.js';

export default async function handler(req, res) {
  try {
    const { m, code } = req.query;
    const IXC = { US: 'SPX', KR: 'KOSPI' }[m];
    const [bars, eng, sum, rec, ixb, ueff, shm] = await Promise.all([store.getBars(m, code), engineState(), m === 'IX' ? null : store.get(`fund:sum:${m}`), m === 'KR' ? store.get(`fund:KR:${code}`) : null,
      IXC ? store.getBars('IX', IXC) : null, IXC ? store.get(`mkt:eff:${m}`) : null, IXC ? store.get(`mcap:${m}`) : null]);
    if (!bars) return send(res, 404, { error: '저장된 일봉이 없어' });
    const P = m === 'IX' ? indexParams(bars, eng.params).P : eng.params;   // 지수는 변동성 보정 임계값 (v2 는 그대로)
    const A = analyze(bars, P, eng.cal, KEEP), { summary, series } = A, history = historyOf(A, eng.cal, KEEP);
    const ix = ixb?.d?.length ? new Series(ixb.d, ixb.c, ixb.v) : null;
    const effect = { ...effectOf(A, history, ix, KEEP), ix: ix ? IXC : null, univ: ueff || null };
    const fund = sum?.rows?.find(r => r.code === code) || null;
    const view = m === 'IX' ? null : opinion(summary, fund, volumeSignal(bars));
    const sector = m === 'IX' ? null : (await loadSecOvr(m))[code] || fund?.sector || sectorOf(m, code, { name: req.query.name || null });
    const mcap = m === 'IX' ? null : mcapOf(shm?.rows?.[code]?.[0], summary.last, m, shm?.fx);   // 원화 시가총액 (원)
    send(res, 200, { summary, series, history, effect, cal: eng.cal, src: bars.src || null, sector, mcap,
      fund: fund ? { ...fund, rank: sum.rows.indexOf(fund) + 1, of: sum.n, at: sum.at } : null, view,
      est: rec?.kr ? { yearly: rec.kr.yearly, quarterly: rec.kr.quarterly, at: rec.at } : null });
  } catch (e) { send(res, 500, { error: e.message }); }
}
