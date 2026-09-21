// POST /api/remove {m, code} (관리자) — 목록에서 빼고 매일 갱신도 멈춤. 학습 라벨 종목이면 일봉은 남김
import * as store from '../lib/store.js';
import { isAdmin, send, body } from '../lib/service.js';
import L from '../lib/labels.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
  if (!isAdmin(req)) return send(res, 401, { error: '관리자 키가 필요해' });
  try {
    const { m, code } = await body(req);
    await store.listDel(m, code);
    if (!L.stocks.some(s => s.m === m && s.code === code)) await store.del(store.barsKey(m, code));
    send(res, 200, { ok: true });
  } catch (e) { send(res, 500, { error: e.message }); }
}
