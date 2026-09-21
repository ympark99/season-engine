// POST /api/add  {items:[{m,code,name,excd?}]}  (관리자) — KIS 에서 2년+워밍업 일봉을 바로 조회해서 목록에 추가
import * as store from '../lib/store.js';
import { refresh, engineState, row, isAdmin, send, body } from '../lib/service.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
  if (!isAdmin(req)) return send(res, 401, { error: '관리자 키가 필요해' });
  try {
    const { items = [] } = await body(req);
    if (!items.length || items.length > 4) return send(res, 400, { error: '한 번에 1~4종목' });
    const eng = await engineState(), out = [];
    for (const x of items) {
      const item = { m: x.m, code: String(x.code).trim().toUpperCase(), name: x.name || x.code, excd: x.excd || null, addedAt: new Date().toISOString() };
      if (!/^(KR|US)$/.test(item.m) || !(item.m === 'KR' ? /^[0-9A-Z]{6}$/ : /^[A-Z.\-]{1,10}$/).test(item.code)) { out.push({ ...item, error: '코드 형식 오류' }); continue; }
      try {
        const { bars, excd } = await refresh(item);
        item.excd = excd;
        await store.listPut(item);
        out.push(row(item, bars, eng));
      } catch (e) { out.push({ ...item, error: e.message }); }
    }
    send(res, 200, { stocks: out });
  } catch (e) { send(res, 500, { error: e.message }); }
}
