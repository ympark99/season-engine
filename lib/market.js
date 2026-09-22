// 시장 지수 국면 — 미국: 나스닥 종합·S&P 500·러셀 2000 / 한국: 코스피·코스닥
// 지수 API 로 먼저 받고, 안 되면 추종 ETF 로 대신함 (화면에 출처 표시). 한 번 정해진 출처는 계속 씀 → 시계열이 섞이지 않음.
import * as store from './store.js';
import * as kis from './kis.js';
import { startDate, needFrom } from './service.js';

export const INDICES = [
  { code: 'COMP', grp: 'US', name: '나스닥 종합', srcs: [{ k: 'usix', id: 'COMP' }, { k: 'usix', id: '.IXIC' }, { k: 'us', id: 'QQQ', excd: 'NAS', label: 'QQQ(나스닥100 ETF) 대용' }] },
  { code: 'SPX', grp: 'US', name: 'S&P 500', srcs: [{ k: 'usix', id: 'SPX' }, { k: 'usix', id: '.INX' }, { k: 'us', id: 'SPY', excd: 'AMS', label: 'SPY(ETF) 대용' }] },
  { code: 'RUT', grp: 'US', name: '러셀 2000', srcs: [{ k: 'usix', id: 'RUT' }, { k: 'usix', id: '.RUT' }, { k: 'us', id: 'IWM', excd: 'AMS', label: 'IWM(ETF) 대용' }] },
  { code: 'KOSPI', grp: 'KR', name: '코스피', srcs: [{ k: 'krix', id: '0001' }, { k: 'kr', id: '069500', label: 'KODEX 200 대용' }] },
  { code: 'KOSDAQ', grp: 'KR', name: '코스닥', srcs: [{ k: 'krix', id: '1001' }, { k: 'kr', id: '229200', label: 'KODEX 코스닥150 대용' }] },
];
const srcLabel = s => s.label || `지수 ${s.id}`;

async function fetchSrc(src, start) {
  if (src.k === 'krix') return kis.krIndexDaily(src.id, start);
  if (src.k === 'usix') return kis.usIndexDaily(src.id, start);
  if (src.k === 'kr') return kis.krDaily(src.id, start);
  return kis.usDaily(src.id, src.excd, start);
}

/** 저장된 출처로 최근 10일만 덧쓰기. 없거나 실패하면 출처 후보를 차례로 전체 조회 */
export async function refreshIndex(ix) {
  const old = await store.getBars('IX', ix.code), errs = [];
  if (old?.src && old.d?.length && old.d[0] <= needFrom()) {
    try {
      const r = await fetchSrc(old.src, new Date(Date.parse(old.d[old.d.length - 1]) - 10 * 864e5));
      const map = new Map(old.d.map((d, i) => [d, [old.c[i], old.v[i]]]));
      const jump = r.d.some((d, i) => map.has(d) && Math.abs(r.c[i] / map.get(d)[0] - 1) > 0.02);
      if (!jump) {
        r.d.forEach((d, i) => map.set(d, [r.c[i], r.v[i]]));
        const d = [...map.keys()].sort(), s = startDate().toISOString().slice(0, 10), k = Math.max(0, d.findIndex(x => x >= s));
        const dd = d.slice(k), bars = { d: dd, c: dd.map(x => map.get(x)[0]), v: dd.map(x => map.get(x)[1]), src: old.src, full: true };
        await store.setBars('IX', ix.code, bars);
        return { bars, added: bars.d.length - old.d.length };
      }
    } catch (e) { errs.push(`${srcLabel(old.src)}: ${e.message.slice(0, 80)}`); }
  }
  for (const src of ix.srcs) {
    try {
      const b = await fetchSrc(src, startDate());
      if (b.d.length < 200) { errs.push(`${srcLabel(src)}: ${b.d.length}봉`); continue; }
      const bars = { d: b.d, c: b.c, v: b.v, src: { ...src, label: srcLabel(src) }, full: true };
      await store.setBars('IX', ix.code, bars);
      return { bars, added: bars.d.length };
    } catch (e) { errs.push(`${srcLabel(src)}: ${e.message.slice(0, 80)}`); }
  }
  throw new Error(`${ix.name} 조회 실패 — ${errs.join(' / ')}`);
}

/** 지수는 종목보다 변동성이 작아서 같은 % 임계값(돌파 b·상승 u·낙폭 d1/d2)이면 국면이 거의 안 바뀜.
 *  최근 1년 일간 변동성 / 종목 기준 2% 비율로 % 임계값만 줄임 (0.35~1배). 기간(TF·TC·W)·거래량 조건은 그대로. */
export const REF_VOL = 0.02;
export function indexParams(bars, P) {
  const c = bars.c, n = c.length, rs = [];
  for (let t = Math.max(1, n - 252); t < n; t++) rs.push(Math.log(c[t] / c[t - 1]));
  const m = rs.reduce((a, x) => a + x, 0) / (rs.length || 1);
  const vol = Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, rs.length - 1));
  const k = Math.min(1, Math.max(0.35, vol / REF_VOL));
  return { P: { ...P, b: P.b * k, u: P.u * k, d1: P.d1 * k, d2: P.d2 * k }, k: +k.toFixed(2), vol: +(vol * 100).toFixed(2) };
}
