// GET /api/stock?m=US&code=VLO — 상세 차트용 시계열 (날짜·종가·국면·Ps) + 국면 변경 내역 + 대장 점수·종합 의견
// 내 목록에 없는 종목(유니버스·펀더멘털 표에서 누른 종목)도 저장된 일봉이 있으면 똑같이 보여준다.
// effect = 국면 효과(계절별 월 환산·위아래 폭·다음 국면, 따라 했다면 3종) + 유니버스 같은 계절 기준선(mkt:eff:{m})
import * as store from '../lib/store.js';
import { engineState, KEEP, send, isAdmin, body } from '../lib/service.js';
import { analyzeV2 as analyze } from '../lib/engine2.js';
import { indexParams } from '../lib/market.js';
import { historyOf } from '../lib/history.js';
import { effectOf } from '../lib/effect.js';
import { Series } from '../lib/engine.js';
import { opinion, volumeSignal } from '../lib/opinion.js';
import { sectorOf } from '../lib/sectors.js';
import { loadSecOvr } from '../lib/themes.js';
import { mcapOf } from '../lib/mcap.js';
import { mcOpt } from '../lib/pullback.js';
import { srPlan, levelsFor, lvStale, OKEY } from '../lib/levels.js';
import { addKijun } from '../lib/kijun.js';
import { bandOf, bandFor } from '../lib/band.js';
import { flowOf, saveFlowOvr, enqueue, queueText } from '../lib/flow.js';

/** GET ?flow=1 — 매출 흐름도 (버튼 누를 때만, 7일 저장) · POST ?flow=1 — 매출처·사업 구성 직접 수정 (관리자) */
async function flow(req, res) {
  if (req.query.flow === 'queue') {                                              // 정기 작업이 읽는 예약 목록 (평문)
    res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.statusCode = 200; return res.end(await queueText());
  }
  const m = req.query.m === 'KR' ? 'KR' : 'US', code = String(req.query.code || '');
  if (!code) return send(res, 400, { error: 'code 가 필요해' });
  if (req.method === 'POST' && req.query.flow === 'req') {                        // 매출 흐름도 분석 예약 (누구나 — 최대 60건)
    const [sum] = await store.mget([`fund:sum:${m}`]), f0 = sum?.rows?.find(r => r.code === code);
    const b = await body(req);
    await enqueue(m, code, { name: req.query.name || f0?.name || code, theme: f0?.theme || null, update: !!b?.update });
  } else if (req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: '관리자 키가 필요해' });
    await saveFlowOvr(m, code, await body(req));
  }
  const [rec, sum] = await store.mget([`fund:${m}:${code}`, `fund:sum:${m}`]);
  const f = sum?.rows?.find(r => r.code === code) || null;
  return send(res, 200, await flowOf(m, code, { name: req.query.name || f?.name || code, theme: f?.theme || null, rec, force: (req.method === 'POST' && req.query.flow !== 'req') || !!req.query.force }));
}

export default async function handler(req, res) {
  try {
    if (req.query.flow) return await flow(req, res);
    const { m, code } = req.query;
    if (req.query.bars) {                                                       // ?bars=1 — 저장된 일봉 원본(날짜·종가·거래량)만 (오프라인 백테스트용)
      const b = await store.getBars(m, code);
      return b ? send(res, 200, { m, code, d: b.d, c: b.c, v: b.v }) : send(res, 404, { error: '저장된 일봉이 없어' });
    }
    const IXC = { US: 'SPX', KR: 'KOSPI' }[m];
    const [bars, eng, sum, rec, ixb, ueff, shm, lv] = await Promise.all([store.getBars(m, code), engineState(), m === 'IX' ? null : store.get(`fund:sum:${m}`), m === 'KR' ? store.get(`fund:KR:${code}`) : null,
      IXC ? store.getBars('IX', IXC) : null, IXC ? store.get(`mkt:eff:${m}`) : null, IXC ? store.get(`mcap:${m}`) : null, IXC ? store.get(`lv:${m}:${code}`) : null]);
    if (!bars) return send(res, 404, { error: '저장된 일봉이 없어' });
    const P = m === 'IX' ? indexParams(bars, eng.params).P : eng.params;   // 지수는 변동성 보정 임계값 (v2 는 그대로)
    const mc = m === 'IX' ? {} : mcOpt(m, shm, code);
    const A = analyze(bars, P, eng.cal, KEEP, mc), { summary, series } = A, history = historyOf(A, eng.cal, KEEP);
    const ix = ixb?.d?.length ? new Series(ixb.d, ixb.c, ixb.v) : null;
    const curvePer = req.query.curve ? String(req.query.curve).slice(0, 4) : null;   // ?curve=1Y — 전략 카드 평가금액 곡선만 (차트용)
    const effect = { ...effectOf(A, history, ix, KEEP, mc, curvePer), ix: ix ? IXC : null, univ: ueff || null };
    const fund = sum?.rows?.find(r => r.code === code) || null;
    const view = m === 'IX' ? null : opinion(summary, fund, volumeSignal(bars));
    const sector = m === 'IX' ? null : (await loadSecOvr(m))[code] || fund?.sector || sectorOf(m, code, { name: req.query.name || null });
    const mcap = m === 'IX' ? null : mcapOf(shm?.rows?.[code]?.[0], summary.last, m, shm?.fx);   // 원화 시가총액 (원)
    // 차트 지지·저항 (눌림목 후보·내 목록만 매일 계산) — 눌림매매 손절·목표 보정
    // 없거나 묵었으면 지금 바로 계산 (종목 조회 때도 지지·저항이 나오게). 실패하면 있던 값 그대로
    let lvNow = lv;
    if (IXC && lvStale(m, lv, summary.lastDate) && !(lv?.none && Date.now() - Date.parse(lv.at || 0) < 864e5)) lvNow = (await levelsFor(m, code)) || lv;
    const lvOk = lvNow && !lvNow.none ? lvNow : null;
    if (lvOk && summary.pb20) summary.pb20.sr = srPlan(summary.pb20, lvOk);
    const ohlc = lvOk ? (lvNow.ohlc !== undefined ? lvNow.ohlc : await store.get(OKEY(m, code))) : null;
    if (ohlc) addKijun(effect, ohlc);                                                   // 일목기준선 매매 — 1년까지 (지지·저항 계산 때 받은 일봉 재사용)
    if (curvePer) return send(res, 200, { curves: effect.curves || null });
    const bd = m === 'KR' ? await bandFor(store, code, rec) : null;                                // 국내 밴드 — 없으면 지금 받아 둠
    const band = bd ? bandOf({ band: bd }, fund?.theme, summary.last) : null;            // PER·PBR 밴드 자기 위치 (작은 차트용 월별 배수 포함)
    send(res, 200, { summary, series, history, effect, cal: eng.cal, src: bars.src || null, sector, mcap, lv: lvOk && { ...lvOk, ohlc: undefined }, band,
      fund: fund ? { ...fund, rank: sum.rows.indexOf(fund) + 1, of: sum.n, at: sum.at } : null, view,
      est: rec?.kr ? { yearly: rec.kr.yearly, quarterly: rec.kr.quarterly, at: rec.at } : null });
  } catch (e) { send(res, 500, { error: e.message }); }
}
