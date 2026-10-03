// 시가총액 — 상장주식수는 KIS 현재가 조회로 2주에 한 번 받아 두고, 시가총액 = 주식수 × 그날 종가 (미국은 × 원/달러 환율).
//   저장: mcap:{m} = { fx, fxAt, rows: { code: [주식수, 받은 시각(ms), 거래소] } }
import * as store from './store.js';
import { krQuote, usQuote } from './kis.js';
import { members, listOf } from './universe.js';

const KEY = m => `mcap:${m}`, FRESH = 14 * 864e5, RETRY = 2 * 864e5;

export const sharesOf = m => store.get(KEY(m));

/** 원화 시가총액 (원). 주식수·가격 없으면 null */
export function mcapOf(sh, px, m, fx) {
  if (!sh || !px) return null;
  if (m === 'US') return fx ? sh * px * fx : null;
  return sh * px;
}

/** 아직 없거나 오래된 종목의 주식수를 시간 예산 안에서 채운다. 반환 { done, got, total } */
export async function fillShares(m, budgetMs = 30000) {
  const t0 = Date.now();
  const [mem, items] = await Promise.all([members(), store.listAll()]);
  const codes = new Map();
  for (const x of listOf(m, mem)) codes.set(x.code, x.excd || null);
  for (const x of items) if (x.m === m && !codes.has(x.code)) codes.set(x.code, x.excd || null);
  const cur = (await store.get(KEY(m))) || { m, fx: null, fxAt: null, rows: {} };
  const now = Date.now(), need = [...codes].filter(([c]) => { const r = cur.rows[c]; return !r || now - r[1] > (r[0] ? FRESH : RETRY); });
  let got = 0, i = 0;
  for (; i < need.length && Date.now() - t0 < budgetMs; i++) {
    const [code, ex] = need[i];
    try {
      if (m === 'KR') { const q = await krQuote(code); cur.rows[code] = [q.shares || 0, Date.now(), null]; if (q.shares) got++; }
      else {
        const q = await usQuote(code, cur.rows[code]?.[2] || ex);
        cur.rows[code] = [q.shares || 0, Date.now(), q.excd || ex];
        if (q.shares) got++;
        if (q.fx) { cur.fx = q.fx; cur.fxAt = new Date().toISOString(); }
      }
    } catch { cur.rows[code] = [cur.rows[code]?.[0] || 0, Date.now(), cur.rows[code]?.[2] || ex]; }
    if (i % 25 === 24) await store.set(KEY(m), cur);
  }
  cur.at = new Date().toISOString();
  await store.set(KEY(m), cur);
  return { done: i >= need.length, got, left: need.length - i, total: codes.size };
}
