// 한국투자증권 KIS Open API — 일봉 조회만 (주문 기능 없음). 서버 함수에서만 호출 → 앱키가 브라우저에 노출되지 않음.
//   국내: GET /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice  tr_id FHKST03010100
//   해외: GET /uapi/overseas-price/v1/quotations/dailyprice                   tr_id HHDFS76240000
// 접근토큰은 1분에 1회만 발급 가능 + 24시간 유효 → Redis 에 23시간 캐시.
import * as store from './store.js';

const BASE = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const SLEEP = +(process.env.KIS_SLEEP ?? 70);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export class KisError extends Error {}

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

async function token() {
  const c = await store.get('kis:token');
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const key = process.env.KIS_APP_KEY, secret = process.env.KIS_APP_SECRET;
  if (!key || !secret) throw new KisError('KIS_APP_KEY / KIS_APP_SECRET 환경변수가 없어');
  if (!(await store.setNX('kis:lock', 1, 65))) {           // 다른 요청이 발급 중 → 잠깐 기다렸다 캐시 사용
    for (let i = 0; i < 20; i++) { await sleep(1000); const c2 = await store.get('kis:token'); if (c2) return c2.token; }
    throw new KisError('토큰 발급 대기 시간 초과');
  }
  const r = await fetch(`${BASE}/oauth2/tokenP`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: key, appsecret: secret }) });
  const t = await r.text();
  if (!r.ok || !t.includes('access_token')) { await store.del('kis:lock'); throw new KisError(`토큰 발급 실패 ${r.status}: ${t.slice(0, 200)}`); }
  const j = JSON.parse(t);
  await store.set('kis:token', { token: j.access_token, exp: Date.now() + 23 * 3600e3 }, 23 * 3600);
  return j.access_token;
}

async function call(path, trId, params) {
  const tk = await token();
  const qs = new URLSearchParams(params).toString();
  let last = '';
  for (let a = 0; a < 4; a++) {
    await sleep(SLEEP);
    const r = await fetch(`${BASE}${path}?${qs}`, { headers: {
      'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${tk}`,
      appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: 'P' } });
    last = await r.text();
    if (r.ok) {
      const j = JSON.parse(last);
      if (j.rt_cd === '0') return j;
      if (j.msg_cd === 'EGW00201') { await sleep(1000 + a * 500); continue; }        // 초당 건수 초과
      if (j.msg_cd === 'EGW00123') { await store.del('kis:token'); throw new KisError('토큰 만료 — 다시 시도해줘'); }
      throw new KisError(`${trId} ${j.msg_cd} ${j.msg1}`);
    }
    await sleep(800 + a * 500);
  }
  throw new KisError(`${trId} HTTP 실패: ${last.slice(0, 200)}`);
}

/** 국내 일봉 [{d,c,v}] 오래된 순. 수정주가. 140일 창으로 과거 방향 페이지 */
export async function krDaily(code, start, end = new Date()) {
  const rows = new Map();
  let curEnd = new Date(end);
  while (curEnd >= start) {
    const curStart = new Date(Math.max(+start, +curEnd - 140 * 864e5));
    const j = await call('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd(curStart), FID_INPUT_DATE_2: ymd(curEnd),
      FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0' });
    const got = (j.output2 || []).filter(x => x.stck_bsop_date);
    for (const x of got) rows.set(iso(x.stck_bsop_date), [+x.stck_clpr, +(x.acml_vol || 0)]);
    if (!got.length) break;
    const oldest = got.map(x => x.stck_bsop_date).sort()[0];
    const nxt = new Date(Date.UTC(+oldest.slice(0, 4), +oldest.slice(4, 6) - 1, +oldest.slice(6, 8)) - 864e5);
    if (nxt >= curEnd) break;
    curEnd = nxt;
  }
  return pack(rows);
}

/** 해외 일봉 — BYMD 기준 과거 100봉씩 */
export async function usDailyOn(symb, excd, start) {
  const rows = new Map(); let bymd = '';
  for (let i = 0; i < 20; i++) {
    const j = await call('/uapi/overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', { AUTH: '', EXCD: excd, SYMB: symb, GUBN: '0', BYMD: bymd, MODP: '1' });
    const got = (j.output2 || []).filter(x => x.xymd && x.clos);
    for (const x of got) rows.set(iso(x.xymd), [+x.clos, +(x.tvol || 0)]);
    if (got.length < 2) break;
    const oldest = got.map(x => x.xymd).sort()[0];
    if (iso(oldest) <= start.toISOString().slice(0, 10)) break;
    const o = new Date(Date.UTC(+oldest.slice(0, 4), +oldest.slice(4, 6) - 1, +oldest.slice(6, 8)) - 864e5);
    bymd = ymd(o);
  }
  const b = pack(rows), s = start.toISOString().slice(0, 10), k = b.d.findIndex(d => d >= s);
  return k <= 0 ? b : { d: b.d.slice(k), c: b.c.slice(k), v: b.v.slice(k) };
}

/** 거래소를 모르면 NAS → NYS → AMS 순으로 찾음 */
export async function usDaily(symb, excd, start) {
  const order = [excd, 'NAS', 'NYS', 'AMS'].filter((x, i, a) => x && a.indexOf(x) === i);
  for (const ex of order) { const b = await usDailyOn(symb, ex, start); if (b.d.length) return { ...b, excd: ex }; }
  return { d: [], c: [], v: [], excd };
}

function pack(rows) {
  const d = [...rows.keys()].sort();
  return { d, c: d.map(k => rows.get(k)[0]), v: d.map(k => rows.get(k)[1]) };
}

/** 날짜 창을 과거로 옮겨가며 조회 (지수 API 는 1회 100봉 한도 → 130일 창) */
async function pageBack(start, end, win, fetchWin) {
  const rows = new Map(); let curEnd = new Date(end);
  for (let i = 0; i < 40 && curEnd >= start; i++) {
    const curStart = new Date(Math.max(+start, +curEnd - win * 864e5));
    const got = await fetchWin(ymd(curStart), ymd(curEnd));
    for (const [d, c, v] of got) if (c > 0) rows.set(iso(d), [c, v]);
    if (!got.length) break;
    const oldest = got.map(x => x[0]).sort()[0];
    const nxt = new Date(Date.UTC(+oldest.slice(0, 4), +oldest.slice(4, 6) - 1, +oldest.slice(6, 8)) - 864e5);
    if (nxt >= curEnd) break;
    curEnd = nxt;
  }
  return pack(rows);
}

/** 국내 업종지수 일봉 — 0001 코스피, 1001 코스닥 (FHKUP03500100) */
export const krIndexDaily = (iscd, start, end = new Date()) => pageBack(start, end, 130, async (d1, d2) => {
  const j = await call('/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice', 'FHKUP03500100', {
    FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: iscd, FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2, FID_PERIOD_DIV_CODE: 'D' });
  return (j.output2 || []).filter(x => x.stck_bsop_date).map(x => [x.stck_bsop_date, +x.bstp_nmix_prpr, +(x.acml_vol || 0)]);
});

/** 해외지수 일봉 — SPX, COMP 등 (FHKST03030100, 시장구분 N) */
export const usIndexDaily = (iscd, start, end = new Date()) => pageBack(start, end, 130, async (d1, d2) => {
  const j = await call('/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', 'FHKST03030100', {
    FID_COND_MRKT_DIV_CODE: 'N', FID_INPUT_ISCD: iscd, FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2, FID_PERIOD_DIV_CODE: 'D' });
  return (j.output2 || []).filter(x => x.stck_bsop_date).map(x => [x.stck_bsop_date, +x.ovrs_nmix_prpr, +(x.acml_vol || 0)]);
});
