// GET  /api/list         — 목록 전체를 판정해서 반환 (가격은 저장된 일봉, 계산은 요청 때마다)
// POST /api/add          — 종목 추가 (관리자). vercel.json rewrite 로 ?op=add 로 들어옴
// POST /api/remove       — 종목 삭제 (관리자). ?op=remove
// GET  /api/list?op=mcap — 시가총액 재료 (상장주식수·환율)
// Hobby 플랜 함수 12개 제한 때문에 세 엔드포인트를 한 함수로 합쳤다. 주소는 그대로다.
import * as store from '../lib/store.js';
import { engineState, row, send, refresh, isAdmin, body, KEEP } from '../lib/service.js';
import { analyzeV2, JUDGE_REV } from '../lib/engine2.js';
import { historyOf } from '../lib/history.js';
import { effectOf } from '../lib/effect.js';
import { SEASONS } from '../lib/engine.js';
import { opinion, volumeSignal } from '../lib/opinion.js';
import { sectorOf } from '../lib/sectors.js';
import { themeOf, loadSecOvr } from '../lib/themes.js';
import { mcapOf, sharesOf } from '../lib/mcap.js';
import { krQuote, usQuote } from '../lib/kis.js';
import { collectOne, scoreAll } from './fundamentals.js';

/** POST /api/add {items:[{m,code,name,excd?}]} — KIS 에서 5년+워밍업 일봉을 바로 조회해서 목록에 추가 */
async function add(req, res) {
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
  // 펀더멘털(대장 점수) — 재료가 없으면 바로 모으고 점수를 다시 낸다. 실패해도 추가는 그대로 (다음 수집 때 다시)
  const need = [];
  for (const it of out.filter(x => !x.error)) if (!(await store.get(`fund:${it.m}:${it.code}`))) need.push(it);
  const ms = new Set();
  for (const it of need) { try { await collectOne(it.m, it.code); ms.add(it.m); } catch (e) { it.fundError = e.message.slice(0, 120); } }
  for (const m of ms) { try { await scoreAll(m); } catch { /* 다음 수집 때 */ } }
  send(res, 200, { stocks: out, fund: [...ms] });
}

/** POST /api/remove {m, code} — 목록에서 빼고 매일 갱신도 멈춤. 유니버스 종목이면 일봉은 남긴다 (매일 스캔이 계속 씀) */
async function remove(req, res) {
  const { m, code } = await body(req);
  await store.listDel(m, code);
  const mem = await store.get('univ:members');
  const inUniv = Object.values(mem?.sets || {}).some(xs => xs.some(x => x.code === code));
  if (!inUniv) await store.del(store.barsKey(m, code));
  send(res, 200, { ok: true });
}

async function list(req, res) {
  const [items, eng, cron] = await Promise.all([store.listAll(), engineState(), store.mget(['cron:KR', 'cron:US'])]);
  const bars = await store.mgetBars(items);
  const [fUS, fKR, shUS, shKR, oUS, oKR] = await store.mget(['fund:sum:US', 'fund:sum:KR', 'mcap:US', 'mcap:KR', 'theme:ovr:US', 'theme:ovr:KR']);
  const OVR = { US: oUS || {}, KR: oKR || {} }, SOVR = { US: await loadSecOvr('US'), KR: await loadSecOvr('KR') };
  const SH = { US: shUS, KR: shKR };
  const fund = {};
  for (const s of [fUS, fKR]) for (const r of s?.rows || []) fund[`${s.m}:${r.code}`] = r;

  const fitKeys = items.map(it => `fit:${it.m}:${it.code}`), fits = await store.mget(fitKeys), fitPut = [];
  const stocks = items.map((it, i) => {
    let r, A = null;
    if (!bars[i] || bars[i].d.length < 80) r = row(it, bars[i], eng);
    else { A = analyzeV2(bars[i], eng.params, eng.cal, KEEP); r = { ...it, ...A.summary }; }
    // 계절 적합도 (상세 화면 맨 위 태그와 같은 판정) — 마지막 봉이 바뀔 때만 다시 계산
    if (A) {
      const fc = fits[i];
      if (fc && fc.ld === r.lastDate && fc.rev === JUDGE_REV) r.fit = fc.fit;
      else try { const f = effectOf(A, historyOf(A, eng.cal, KEEP), null, KEEP).fit; r.fit = f ? { grade: f.grade, label: f.label, why: f.why } : null; fitPut.push([fitKeys[i], { ld: r.lastDate, rev: JUDGE_REV, fit: r.fit }]); }
      catch { r.fit = null; }
    }
    const f = fund[`${it.m}:${it.code}`] || null;
    if (!r.error) r.view = opinion(r, f, volumeSignal(bars[i]));
    r.sector = SOVR[it.m][it.code] || f?.sector || sectorOf(it.m, it.code, { name: it.name });
    r.themeAuto = themeOf(it.m, it.code, r.sector);                              // 직접 지정을 지우면 돌아갈 자동 분류
    r.theme = OVR[it.m]?.[it.code] || r.themeAuto;                               // 화면의 '섹터' (lib/themes.js)
    const sh = SH[it.m]?.rows?.[it.code]?.[0];                                 // 시가총액(원) = 상장주식수 × 종가 (미국은 × 원/달러)
    if (!r.error) r.mcap = mcapOf(sh, r.last, it.m, SH[it.m]?.fx) ?? null;
    return r;
  });
  if (fitPut.length) await Promise.all(fitPut.map(([k, v]) => store.set(k, v)));
  const regime = {}, events = [];
  for (const m of ['US', 'KR']) {
    const xs = stocks.filter(s => s.m === m && !s.error);
    const cnt = Object.fromEntries(SEASONS.map(s => [s, xs.filter(x => x.season === s).length]));
    regime[m] = { n: xs.length, cnt, asof: xs.reduce((a, x) => (x.lastDate > a ? x.lastDate : a), '') || null };
  }
  for (const s of stocks) for (const e of s.events || []) events.push({ m: s.m, code: s.code, name: s.name, ...e });
  stocks.forEach(s => delete s.events);
  events.sort((a, b) => (a.d < b.d ? 1 : -1));
  send(res, 200, { now: new Date().toISOString(), engine: { calAt: eng.calAt, tunedAt: eng.tunedAt, cal: eng.cal?.src === 'truth' }, cron: { KR: cron[0], US: cron[1] }, regime, events, stocks,
    fund: { US: fUS ? { at: fUS.at, n: fUS.n } : null, KR: fKR ? { at: fKR.at, n: fKR.n } : null },
    mcap: { US: shUS ? { fx: shUS.fx, fxAt: shUS.fxAt, at: shUS.at } : null, KR: shKR ? { at: shKR.at } : null } });
}

/** GET /api/list?op=mcap&m=US — 펀더멘털 표용 상장주식수·환율·최근 종가. ?code=CRWD 를 붙이면 KIS 원응답 일부로 조회 확인 (공개 시세 정보만) */
async function mcap(req, res) {
  const m = req.query.m === 'KR' ? 'KR' : 'US';
  if (req.query.code) {
    const code = String(req.query.code).toUpperCase();
    return send(res, 200, { m, code, q: m === 'KR' ? await krQuote(code) : await usQuote(code, req.query.excd || null) });
  }
  const [sh, univ] = await Promise.all([sharesOf(m), store.get(`univ:res:${m}`)]);
  const out = { m, fx: sh?.fx ?? null, fxAt: sh?.fxAt ?? null, at: sh?.at ?? null, sh: {}, px: {} };
  for (const [code, r] of Object.entries(sh?.rows || {})) if (r[0] > 0) { out.sh[code] = r[0]; const c = univ?.rows?.[code]?.c; if (c) out.px[code] = c; }
  send(res, 200, out);
}

export default async function handler(req, res) {
  try {
    const op = req.query.op;
    if (op === 'mcap') return await mcap(req, res);
    if (op === 'add' || op === 'remove') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
      if (!isAdmin(req)) return send(res, 401, { error: '관리자 키가 필요해' });
      return op === 'add' ? add(req, res) : remove(req, res);
    }
    return list(req, res);
  } catch (e) { send(res, 500, { error: e.message }); }
}
