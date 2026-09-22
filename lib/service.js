// 서버 함수들이 같이 쓰는 로직
import * as store from './store.js';
import * as kis from './kis.js';
import { DEFAULT_PARAMS, DEFAULT_CAL_V2, analyze } from './engine.js';

export const FETCH_DAYS = 5 * 365 + 150;   // 표시 5년 + 판정 워밍업(60일 이평·52주 고점)
export const KEEP = 1265;                   // 화면에 보내는 최근 봉 수 ≈ 5년

export const today = () => new Date();
export const startDate = () => new Date(Date.now() - FETCH_DAYS * 864e5);
/** 보관 데이터가 이 날짜보다 늦게 시작하면 과거가 모자란 것 (휴장·상장일 여유 45일) */
export const needFrom = () => new Date(Date.now() - (FETCH_DAYS - 45) * 864e5).toISOString().slice(0, 10);

export async function engineState() {
  const e = await store.get('engine');
  return { params: { ...DEFAULT_PARAMS, ...(e?.params || {}) }, cal: e?.cal || DEFAULT_CAL_V2, trainedAt: e?.trainedAt || null, fit: e?.fit || null, anchors: e?.anchors || [] };
}

function trim(b) {
  const s = startDate().toISOString().slice(0, 10), k = b.d.findIndex(d => d >= s);
  return k <= 0 ? b : { d: b.d.slice(k), c: b.c.slice(k), v: b.v.slice(k) };
}

async function fetchRange(item, start) {
  if (item.m === 'KR') return { ...(await kis.krDaily(item.code, start)), excd: null };
  return kis.usDaily(item.code, item.excd, start);
}

/** 신규면 2년+워밍업 전체, 있으면 마지막 10일 전부터 덧쓰기. 과거 종가가 2% 넘게 바뀌면(분할 등) 전체 재조회 */
export async function refresh(item, { full = false } = {}) {
  let old = full ? null : await store.getBars(item.m, item.code);
  if (old?.d?.length && !old.full && old.d[0] > needFrom()) old = null;   // 예전(2년) 데이터면 5년으로 전체 재조회 (상장 5년 미만은 full 표시로 1회만)
  let got, excd = item.excd, wasFull = !!old?.full;
  if (old?.d?.length) {
    const from = new Date(Date.parse(old.d[old.d.length - 1]) - 10 * 864e5);
    const r = await fetchRange(item, from); excd = r.excd || excd;
    const idx = new Map(old.d.map((d, i) => [d, old.c[i]]));
    if (r.d.some((d, i) => idx.has(d) && Math.abs(r.c[i] / idx.get(d) - 1) > 0.02)) { old = null; got = await fetchRange(item, startDate()); excd = got.excd || excd; wasFull = true; }
    else got = r;
  } else { got = await fetchRange(item, startDate()); excd = got.excd || excd; wasFull = true; }
  const map = new Map();
  if (old) old.d.forEach((d, i) => map.set(d, [old.c[i], old.v[i]]));
  got.d.forEach((d, i) => map.set(d, [got.c[i], got.v[i]]));
  const d = [...map.keys()].sort();
  const bars = { ...trim({ d, c: d.map(k => map.get(k)[0]), v: d.map(k => map.get(k)[1]) }), full: wasFull };
  if (!bars.d.length) throw new Error(`${item.code}: KIS 에서 일봉을 못 찾았어 (코드·거래소 확인)`);
  await store.setBars(item.m, item.code, bars);
  return { bars, excd, added: bars.d.length - (old?.d?.length || 0) };
}

export function row(item, bars, eng) {
  if (!bars || bars.d.length < 80) return { ...item, error: bars ? `데이터 부족 (${bars.d.length}봉)` : '데이터 없음' };
  const { summary } = analyze(bars, eng.params, eng.cal, KEEP);
  return { ...item, ...summary };
}

export function isAdmin(req) {
  const t = process.env.ADMIN_TOKEN;
  return !!t && req.headers['x-admin-token'] === t;
}

export function send(res, code, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(body);
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
