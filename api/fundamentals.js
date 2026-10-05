// /api/fundamentals — 대장 엔진 재료. 유니버스 전종목 재무·추정치를 주 1회 조각내서 모으고 점수화한다.
//   GET                      → 수집 상태 + 점수 요약 (공개)
//   GET ?code=BE             → 한 종목 지표·분기 원자료
//   GET ?all=1&m=US          → 점수 전체 목록 (대시보드 표)
//   GET ?auto=US|KR&secret=.. → 남은 수집 한 조각 실행 (파이프라인이 부름)
//   GET ?probe=CODE&m=KR      → 원응답 스키마 확인 (관리자)
//   POST {step:'collect'|'score'|'one', m, code, reset}   (관리자)
// 미국은 분기 재무 + 애널리스트 컨센서스(연간 EPS·매출 추정, lib/estimates.js), 국내는 추정실적을 쓴다 — 점수 축은 동일. 제공처 이름은 코드·화면에 쓰지 않는다.
import * as store from '../lib/store.js';
import { isAdmin, send, body } from '../lib/service.js';
import { fetchStatement, normalize, metricsAt, rawScores } from '../lib/fundamentals.js';
import { fetchForward, blendForward } from '../lib/forward.js';
import { fetchKrInfo, normalizeKr, krMetrics, krRawScores, epsSnapshot } from '../lib/krfund.js';
import { members, listOf, kstDate } from '../lib/universe.js';
import { sectorOf } from '../lib/sectors.js';
import { loadSecOvr, loadOvr, themeOf, GROUPS } from '../lib/themes.js';
import { krStockInfo } from '../lib/kis.js';
import { collectEstimates, loadEstimates, estForward, fwdTable } from '../lib/estimates.js';

/** 수집·점수 대상 — 유니버스 전종목(AI 밸류체인 추가 종목 포함) + 유니버스에 없는 내 목록 종목 (검색으로 추가한 종목도 대장 점수가 나오게) */
export async function targetsOf(m) {
  const [mem, mine] = await Promise.all([members(), store.listAll()]);
  const list = listOf(m, mem), have = new Set(list.map(x => x.code));
  for (const it of mine) if (it?.m === m && !have.has(it.code)) { list.push({ code: it.code, name: it.name, tags: ['내 목록'] }); have.add(it.code); }
  return list;
}

const KEY = (m, c) => `fund:${m}:${c}`, S_STATE = m => `fund:state:${m}`, S_SUM = m => `fund:sum:${m}`;
const CHUNK_MS = 35000, GAP_MS = +(process.env.FUND_GAP ?? 1000), STALE_DAYS = 7;          // 요청 사이 1초 (빨리 보내면 봇 차단)
const FWD_IDX = 'fwd:at:US', FWD_BLOCK = 'fwd:block:US', FWD_DAY = 'fwd:day:US';
const FWD_GAP = +(process.env.FWD_GAP ?? 2500), FWD_PER_DAY = 600, FWD_STALE = 7;
const isBlock = e => /HTTP (403|429)/.test(String(e?.message || ''));
const staleDays = m => (m === 'KR' ? 3 : STALE_DAYS);    // 국내는 추정 변화 기록을 촘촘히 쌓으려고 3일마다
const sleep = ms => new Promise(r => setTimeout(r, ms));
const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query?.secret === process.env.CRON_SECRET);

/** 한 종목 — 미국은 분기 재무 3회 + 선행 지표 1회, 국내는 컨센서스 연간·분기 2회 */
export async function collectOne(m, code) {
  if (m === 'KR') {
    const [prev, bars] = await store.mget([KEY(m, code), store.barsKey('KR', code)]);
    const norm = normalizeKr(await fetchKrInfo(code));
    const snap = epsSnapshot(norm);
    const hist = [...(prev?.hist || []).filter(h => h.d !== snap.d), snap].slice(-60);        // 추정 EPS 기록 (추정 상향/하향 계산용)
    const price = bars?.c?.length ? bars.c[bars.c.length - 1] : null;
    const metrics = krMetrics(norm, { price, hist });
    let secRaw = prev?.secRaw || null, secAt = prev?.secAt || null;            // 업종명은 60일에 한 번만 KIS 에서 받는다
    if (!secAt || Date.now() - Date.parse(secAt) > 60 * 864e5) {
      try { const si = await krStockInfo(code); secRaw = si.std || si.idx || secRaw; secAt = new Date().toISOString(); } catch { /* 섹터는 없어도 진행 */ }
    }
    const rec = { code, m, at: new Date().toISOString(), currency: 'KRW', kr: norm, hist, metrics, secRaw, secAt };
    await store.set(KEY(m, code), rec);
    return rec;
  }
  const iq = await fetchStatement(code, 'IQ'); await sleep(GAP_MS);
  const cq = await fetchStatement(code, 'CQ'); await sleep(GAP_MS);
  const bq = await fetchStatement(code, 'BQ');
  const rows = normalize({ IQ: iq, CQ: cq, BQ: bq });
  const metrics = metricsAt(rows);
  let fwd = null;
  try { await sleep(GAP_MS); fwd = await fetchForward(code); } catch (e) { fwd = { ok: false, why: e.message.slice(0, 80), at: new Date().toISOString() }; }   // 선행치는 없어도 진행
  const rec = { code, m, at: new Date().toISOString(), currency: iq.currency || 'USD', rows, metrics, fwd };
  await store.set(KEY(m, code), rec);
  const idx = (await store.get(FWD_IDX)) || {}; idx[code] = rec.at; await store.set(FWD_IDX, idx);
  return rec;
}

/** 수집 한 조각 — 오래된 종목부터.
 *  한 바퀴가 끝나면 STALE_DAYS 가 지나기 전에는 다시 돌지 않는다.
 *  (예전엔 끝나자마자 다음 호출에서 진행 0/N 으로 새 바퀴를 시작해서, 화면에선 수집한 게 날아간 것처럼 보였다) */
export async function collectChunk(m, { reset = false } = {}) {
  const t0 = Date.now(), today = kstDate();
  let est = null;
  if (m === 'US') try { est = await collectEstimates((await targetsOf(m)).map(x => x.code), { budgetMs: 40000 }); } catch (e) { est = { error: e.message }; }   // 하루 한 번, 이미 받은 종목은 건너뜀
  let st = await store.get(S_STATE(m));
  if (m === 'US') {                                                               // 재무 제공처에 차단됐으면 6시간 동안 손대지 않는다
    const blk = await store.get(FWD_BLOCK);
    if (blk) return { m, i: st?.i ?? 0, total: st?.codes?.length ?? 0, got: 0, est, blocked: `차단 대기 (${blk.at})`, done: true, idle: true, fwdLeft: 0, ms: Date.now() - t0 };
  }
  const endAt = st?.finishedAt || st?.updatedAt || null;                          // 예전 상태엔 finishedAt 이 없어서 다음 바퀴가 영영 안 시작됐다
  const cycleOld = st?.done && (!endAt || Date.now() - Date.parse(endAt) > (st.blocked ? 20 * 3600e3 : staleDays(m) * 864e5));   // 막혔던 바퀴는 다음 날 다시 시도
  if (st?.done && !reset && !cycleOld) {
    const cu = await catchUp(m, t0), fw = await refreshForward(m, 30000);
    if ((est?.got || fw.got) && !cu.got) await scoreAll(m);                         // 추정치·선행 지표가 새로 들어왔으면 점수 다시
    return { m, i: st.i, total: st.codes.length, ...cu, est, fwd: fw, fwdLeft: fw.left || 0, skipped: 0, failed: st.failed.length, done: true, idle: true, ms: Date.now() - t0 };
  }
  if (reset || !st || !st.codes?.length || st.done) {
    const list = await targetsOf(m);
    if (!list.length) throw new Error('구성종목이 없어 — 유니버스 스캔을 먼저 돌려줘');
    st = { m, started: today, i: 0, codes: list.map(x => x.code), failed: [], done: false, prevN: st?.collected ?? null };
  }
  const fresh = new Date(Date.now() - staleDays(m) * 864e5).toISOString();
  let got = 0, skipped = 0;
  while (st.i < st.codes.length && Date.now() - t0 < CHUNK_MS) {
    const code = st.codes[st.i];
    const cur = await store.get(KEY(m, code));
    if (cur?.at > fresh && !reset) { skipped++; st.i++; continue; }
    try { await collectOne(m, code); got++; }
    catch (e) {
      st.failed.push({ code, error: e.message.slice(0, 140) }); if (st.failed.length > 300) st.failed = st.failed.slice(-300);
      if (m === 'US' && isBlock(e)) { await store.set(FWD_BLOCK, { at: new Date().toISOString(), why: e.message }, 6 * 3600); st.pausedAt = new Date().toISOString(); break; }   // 봇 차단 — 6시간 쉬고 같은 종목부터 (st.i 그대로)
    }
    st.i++;
    await sleep(GAP_MS);
    // 국내 제공처가 통째로 막힌 경우 — 첫 10종목이 전부 같은 이유로 실패하면 그 바퀴를 멈추고 이유를 남긴다
    if (m === 'KR' && st.i === 10 && st.failed.length >= 10) { st.blocked = st.failed[0].error; break; }
  }
  st.done = st.i >= st.codes.length || !!st.blocked;
  st.updatedAt = new Date().toISOString();
  if (st.done) {
    st.finishedAt = st.updatedAt;
    const sum = await scoreAll(m);
    st.collected = sum.n;
  }
  else if (est?.got) await scoreAll(m);
  await store.set(S_STATE(m), st);
  return { m, i: st.i, total: st.codes.length, got, skipped, est, failed: st.failed.length, done: st.done, blocked: st.blocked || null, ms: Date.now() - t0 };
}

/** 선행 지표(요약표)만 다시 받기 — 재무 3종은 그대로 두고 1회 요청만. 7일 지난 종목만, 요청 사이 2.5초, 하루 600종목까지.
 *  예전 기록(선행 지표 기능 전에 모은 것)은 선행 PER 이 비어 있어서 이걸로 채운다. 차단(403·429)되면 6시간 쉰다. */
export async function refreshForward(m, budgetMs = 30000) {
  if (m !== 'US') return { got: 0, left: 0 };
  const t0 = Date.now(), today = kstDate();
  if (await store.get(FWD_BLOCK)) return { got: 0, left: 0, blocked: true };
  const [idx0, day0] = await store.mget([FWD_IDX, FWD_DAY]);
  const idx = idx0 || {}, day = day0?.d === today ? day0 : { d: today, n: 0 };
  if (day.n >= FWD_PER_DAY) return { got: 0, left: 0, capped: true };
  const cut = Date.now() - FWD_STALE * 864e5;
  const sum = await store.get(S_SUM(m));                                          // 점수에 들어간 종목만 (재무가 아직 없는 종목은 catchUp 이 모은 뒤에)
  const need = (sum?.rows || []).map(x => x.code).filter(c => !idx[c] || Date.parse(idx[c]) < cut);
  let got = 0, tried = 0, blocked = false;
  for (const code of need) {
    if (Date.now() - t0 > budgetMs || day.n >= FWD_PER_DAY) break;
    tried++;
    const rec = await store.get(KEY(m, code));
    if (!rec) continue;                                                          // 재무가 아직 없으면 catchUp 이 모은다
    let fwd;
    try { fwd = await fetchForward(code); got++; }
    catch (e) {
      if (isBlock(e)) { await store.set(FWD_BLOCK, { at: new Date().toISOString(), why: e.message }, 6 * 3600); blocked = true; break; }
      fwd = { ok: false, why: e.message.slice(0, 80), at: new Date().toISOString() };
    }
    rec.fwd = fwd;
    await store.set(KEY(m, code), rec);
    idx[code] = new Date().toISOString(); day.n++;
    await sleep(FWD_GAP);
  }
  await store.set(FWD_IDX, idx); await store.set(FWD_DAY, day);
  return { got, tried, left: blocked ? 0 : Math.max(0, Math.min(need.length - tried, FWD_PER_DAY - day.n)), blocked, ms: Date.now() - t0 };
}

/** 바퀴 사이 쉬는 동안 — 아직 재료가 없는 종목(새로 추가한 내 목록·AI 밸류체인 종목)만 바로 모으고 점수를 다시 낸다.
 *  못 받은 종목은 3일 동안 다시 시도하지 않는다 (ETF 처럼 재무가 없는 종목이 매번 시간을 잡아먹지 않게) */
async function catchUp(m, t0) {
  const list = await targetsOf(m), missKey = `fund:miss:${m}`;
  const miss = (await store.get(missKey)) || {}, cut = Date.now() - 3 * 864e5, have = new Set();
  for (let i = 0; i < list.length; i += 25) {                                  // 재무 기록이 커서 25개씩 나눠 확인
    const part = list.slice(i, i + 25), recs = await store.mget(part.map(x => KEY(m, x.code)));
    recs.forEach((r, k) => { if (r) have.add(part[k].code); });
  }
  const need = list.filter(x => !have.has(x.code) && !(miss[x.code] && Date.parse(miss[x.code]) > cut));
  let got = 0, tried = 0;
  for (const x of need) {
    if (Date.now() - t0 > CHUNK_MS) break;
    tried++;
    try { await collectOne(m, x.code); got++; delete miss[x.code]; } catch { miss[x.code] = new Date().toISOString(); }
    await sleep(GAP_MS);
  }
  if (tried) await store.set(missKey, miss);
  if (got) await scoreAll(m);
  return { got, catchUp: need.length };
}

const pct = (v, sorted) => {                       // 백분위 (0~100)
  if (v == null || !sorted?.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  let up = lo;
  while (up < sorted.length && sorted[up] === v) up++;                              // 같은 값은 가운데 순위 (동점이 전부 0%가 되지 않게)
  const rank = up > lo ? (lo + up - 1) / 2 : lo;
  return Math.round(100 * rank / Math.max(1, sorted.length - 1));
};

/**
 * 가중치 — 나스닥·AI 성장주 위주로 보는 기준 (2026-10-05 조정).
 *   예전: 가속 30 · 성장 15 · 마진 15 · 현금 15 · 질 10 · 싼 정도 10 · 위험 5
 *   가속(성장률의 변화)은 기저가 작으면 값이 튀어서 30% 는 과했다 → 성장과 20:20 으로 나누고,
 *   성장주에서 가장 잘 듣는 '추정 상향'을 10% 새 축으로. 현금은 AI 투자기(설비투자로 FCF 가 일시 마이너스)를 과하게 벌주지 않게 15 → 10.
 *   값이 없는 축(국내 현금·추정 상향, 기록이 쌓이기 전의 추정 상향 등)은 빼고 나머지 가중치로 다시 나눈다.
 */
/** 점수 방식 버전 — 바꾸면 다음 조회 때 저장된 재료로 한 번 다시 매긴다 */
export const SCORE_REV = '2026-10-05p';
export const WEIGHTS = { accel: 0.20, growth: 0.20, revision: 0.10, margin: 0.15, cash: 0.10, quality: 0.10, value: 0.10, risk: 0.05 };
const KEYS = Object.keys(WEIGHTS);
const PEER_K = 8;                                    // 동종 섹터가 작을 때 상위 묶음과 섞는 강도 (섹터 n종목 : 묶음 8종목 비중)
/** 태그 가감점 — 다른 축과 겹치지 않는 것만. 희석·레버리지(위험 축), 자기 과거 대비 비쌈(싼 정도), 현금흐름 개선(현금 축),
 *  이익 정점(가속·마진), 추정 상향/하향(추정 상향 축), 서프라이즈(국내 가속 축)는 이미 축에 들어 있어서 빼고, 추정이 크게 갈리는 불확실성만 깎는다 */
const ADJ = { '추정 편차 큼': -3 };
const clipv = (v, a) => (v == null || !Number.isFinite(v) ? null : Math.max(-a, Math.min(a, v)));
const endOf = (y, mo) => new Date(Date.UTC(y, mo || 12, 0)).toISOString().slice(0, 10);

/** 국내 1·2년 선행 표 — 컨센서스 연간(실적·추정) → 결산월 말일 기준으로 같은 방식 */
function krTable(rec) {
  const ys = (rec?.kr?.yearly || []).filter(r => r.eps != null && r.y).map(r => ({ fy: r.y, end: endOf(r.y, r.m), eps: r.eps, est: !!r.est }));
  return fwdTable(ys, rec?.metrics?.price ?? null);
}

/** 축별 원재료 (백분위 전). pe·gPeg·zv·cashD·cashL 은 싼 정도·현금 축을 여러 비교군으로 나눠 매기려고 따로 둔다 */
function rawOf(m, r) {
  const M = r.metrics, F = r.F;
  if (m === 'KR') {
    const s = krRawScores(M);
    if (!s) return null;
    return { ...s, revision: null, pe: r.tb?.ntm1?.pe ?? M.fwdPe ?? null, gPeg: r.tb?.g ?? M.gEpsFwd ?? null, zv: null, cashD: null, cashL: null };
  }
  const s = blendForward(rawScores(M), F);
  if (!s) return null;
  const finvizAccel = F?.ok && F.src !== 'est' && F.gEpsThisY != null && F.gEpsNextY != null;
  if (!finvizAccel) s.accel = M.noisy ? (M.accelRev ?? M.accelEps) : (M.accelEps ?? M.accelRev);   // 기저가 작아 EPS 증가율이 튀면 매출 가속으로
  if (F?.src === 'est') {
    const gN = F.tb?.g ?? F.gEpsNextY;                                             // 1년 선행 → 2년 선행 EPS 성장 (없으면 FY+1→FY+2)
    s.growth = gN == null ? s.growth : F.gRev12 != null ? 0.7 * clipv(gN, 300) + 0.3 * clipv(F.gRev12, 300) : clipv(gN, 300);
  } else if (!(F?.ok && F.gEpsNextY != null)) s.growth = M.noisy ? (M.gRev ?? M.gEps) : (M.gEps ?? M.gRev);
  s.growth = clipv(s.growth, 300); s.accel = clipv(s.accel, 300);
  s.revision = F?.revUp ?? null;
  s.pe = F?.tb?.ntm1?.pe ?? (F?.ok ? F.fwdPe : null) ?? null;
  s.gPeg = F?.tb?.g ?? (F?.ok ? F.gEpsNextY : null) ?? null;
  s.zv = M.zPs == null ? null : -M.zPs;
  s.cashD = M.dFcfM ?? null; s.cashL = M.fcfM ?? null;
  return s;
}

/** 저장된 지표를 백분위로 환산해 대장 점수 산출.
 *  비교군: 성장·가속·마진 변화·추정 상향·위험은 유니버스 전체 (성장주가 위로 오게),
 *  싼 정도·질(ROIC)·FCF 마진 수준은 업종마다 기준이 달라서 동종 섹터 (작으면 상위 묶음과 섞음) */
export async function scoreAll(m) {
  const list = await targetsOf(m), recs = [];
  // 미국 컨센서스 + 최근 종가 (선행 PER 은 우리 종가 ÷ 추정 EPS)
  const E = m === 'US' ? await loadEstimates() : null, px = {}, today = kstDate();
  if (E) {
    const univ = await store.get(`univ:res:${m}`);
    for (const [c, r] of Object.entries(univ?.rows || {})) if (r?.c) px[c] = r.c;
    const miss = list.filter(x => px[x.code] == null && E.rows[x.code]);
    for (let i = 0; i < miss.length; i += 25) {
      const b = await store.mget(miss.slice(i, i + 25).map(x => store.barsKey(m, x.code)));
      b.forEach((x, k) => { if (x?.c?.length) px[miss[i + k].code] = x.c[x.c.length - 1]; });
    }
  }
  const fwdOf = r => (E && estForward(E.rows[r.code], E.hist[r.code], px[r.code], today)) || (r.fwd?.ok ? r.fwd : null);
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const got = await store.mget(chunk.map(x => KEY(m, x.code)));
    got.forEach((r, j) => { if (r?.metrics?.ok) recs.push({ ...r, name: chunk[j].name, tags: chunk[j].tags }); });
  }
  if (!recs.length) { const prev = await store.get(S_SUM(m)); return prev || { m, n: 0, at: new Date().toISOString(), rows: [] }; }   // 수집이 전부 실패해도 이전 점수는 지우지 않음
  const [ovr, secOvr] = await Promise.all([loadOvr(m), loadSecOvr(m)]);
  const AIG = new Set(GROUPS[m]?.AI || []);
  for (const r of recs) {
    if (m === 'US') { r.F = fwdOf(r); r.tb = r.F?.tb || null; } else r.tb = krTable(r);
    r.sector = secOvr[r.code] || sectorOf(m, r.code, { name: r.name, collected: m === 'KR' ? r.secRaw : r.fwd?.industry });
    r.theme = ovr[r.code] || themeOf(m, r.code, r.sector);
    r.fam = AIG.has(r.theme) ? 'AI' : '*';
  }
  const raw = recs.map(r => ({ r, s: rawOf(m, r) })).filter(x => x.s);
  for (const x of raw) {
    const s = x.s;
    s.peLn = s.pe > 0 ? -Math.log(s.pe) : null;
    s.peg = s.pe > 0 && s.gPeg != null ? -(s.pe / Math.max(1, Math.min(s.gPeg, 100))) : null;   // PEG (성장 1% 미만·역성장이면 PER 그대로 → 비쌈)
  }
  // 비교군별 정렬 배열
  const SUB = ['accel', 'growth', 'revision', 'margin', 'risk', 'quality', 'peLn', 'peg', 'zv', 'cashD', 'cashL'];
  const sortv = arr => arr.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const U = Object.fromEntries(SUB.map(k => [k, sortv(raw.map(x => x.s[k]))]));
  const grp = (keyOf) => { const g = {}; for (const x of raw) (g[keyOf(x.r)] ||= []).push(x); return g; };
  const byTheme = grp(r => r.theme), byFam = grp(r => r.fam);
  const cache = {};
  const sortedOf = (kind, name, k) => (cache[`${kind}|${name}|${k}`] ||= sortv(((kind === 't' ? byTheme : byFam)[name] || []).map(x => x.s[k])));
  const univ = (x, k) => pct(x.s[k], U[k]);
  const peer = (x, k) => {
    const v = x.s[k];
    if (v == null || !Number.isFinite(v)) return null;
    const T = sortedOf('t', x.r.theme, k), Fm = x.r.fam === '*' ? U[k] : sortedOf('f', x.r.fam, k), n = T.length;
    const pF = pct(v, Fm);
    return n < 3 ? pF : Math.round((n * pct(v, T) + PEER_K * pF) / (n + PEER_K));
  };
  const wavg = parts => { let a = 0, w = 0; for (const [v, k] of parts) if (v != null) { a += v * k; w += k; } return w ? Math.round(a / w) : null; };
  const rows = raw.map(x => {
    const { r, s } = x;
    const vPe = peer(x, 'peLn'), vPeg = peer(x, 'peg'), vHist = univ(x, 'zv');
    const p = {
      accel: univ(x, 'accel'), growth: univ(x, 'growth'), revision: univ(x, 'revision'), margin: univ(x, 'margin'),
      cash: wavg([[univ(x, 'cashD'), 1], [peer(x, 'cashL'), 1]]),               // FCF 마진 개선폭(전체) + FCF 마진 수준(동종)
      quality: peer(x, 'quality'),
      value: wavg([[vPe, 0.35], [vPeg, 0.40], [vHist, 0.25]]),                   // 선행 PER(동종) · PEG(동종) · 자기 과거 P/S
      risk: univ(x, 'risk'),
    };
    let wsum = 0, acc = 0;
    for (const k of KEYS) if (p[k] != null) { acc += WEIGHTS[k] * p[k]; wsum += WEIGHTS[k]; }
    const M = r.metrics, F = m === 'US' ? r.F : null, flags = [], RU = M.revUp ?? F?.revUp ?? null;
    if (p.accel != null && p.accel < 20 && (M.dOm ?? 0) < 0) flags.push('이익 정점 경계');      // 정유 매도를 설명하는 규칙
    if (M.funding === '남의 돈' && (M.levEbitda ?? 0) > 3) flags.push('남의 돈 · 레버리지');
    if ((M.dilution ?? 0) > 10) flags.push('희석 10%+');
    if ((M.zPs ?? 0) > 1.5) flags.push('자기 과거 대비 비쌈');                                  // P/S 가 자기 평균보다 1.5 표준편차 넘게 위
    if (s.pe > 0 && s.gPeg >= 15 && s.pe / s.gPeg <= 1) flags.push('성장 대비 쌈');             // PEG 1 이하
    if ((M.fcfPos ?? 0) === 4 && (M.dFcfM ?? 0) > 0) flags.push('현금흐름 개선');
    if ((RU ?? 0) > 3) flags.push('추정 상향');
    if ((RU ?? 0) < -3) flags.push('추정 하향');
    if ((F?.spread1 ?? 0) > 50) flags.push('추정 편차 큼');
    if ((M.surOp ?? 0) >= 5) flags.push('어닝 서프라이즈');
    if ((M.surOp ?? 0) <= -5) flags.push('어닝 쇼크');
    if (M.basis === 'trailing') flags.push('추정치 없음 · 실적 기준');
    if (M.loss) flags.push('적자(PER 없음)');
    if (M.consol === 'P') flags.push('별도 기준');
    const adj = flags.filter(f => ADJ[f]).map(f => ({ t: f, v: ADJ[f] }));
    const base = wsum ? acc / wsum : null, adjSum = adj.reduce((a, b) => a + b.v, 0);
    const score = base == null ? null : +Math.max(0, Math.min(100, base + adjSum)).toFixed(1);
    const peerN = (byTheme[r.theme] || []).length;
    return { code: r.code, name: r.name, tags: (r.tags || []).join('+'), sector: r.sector, theme: r.theme, peerN, peerFam: r.fam === 'AI' ? 'AI 밸류체인' : '전체',
      score, base: base == null ? null : +base.toFixed(1), adj, p, pv: { pe: vPe, peg: vPeg, hist: vHist }, peg: s.pe > 0 && s.gPeg > 0 ? +(s.pe / s.gPeg).toFixed(2) : null,
      flags, funding: M.funding,
      q: M.q, asOf: M.asOf, gRev: M.gRev, gEps: M.gEps, accelEps: M.accelEps, accelRev: M.accelRev,
      om: M.om, dOm: M.dOm, fcfM: M.fcfM, roic: M.roic ?? M.roeFwd, zPs: M.zPs, lev: M.levEbitda, dilution: M.dilution, noisy: M.noisy,
      fwdEps: M.fwdEps ?? F?.epsNextY ?? null, fwdPe: M.fwdPe ?? F?.fwdPe ?? null,
      gEpsFwd: M.gEpsFwd ?? F?.gEpsNextY ?? null, revUp: RU, rs: M.rs ?? null,
      fwdPe2: F?.pe2 ?? null, fwdEps2: F?.eps2 ?? null, fy1: F?.fy1 ?? null, fy2: F?.fy2 ?? null, gEps23: F?.g23 ?? null, gRevFwd: F?.gRev12 ?? null,
      estSpread: F?.spread1 ?? null, estN: F?.n1 ?? null, tb: r.tb || null,
      surOp: M.surOp ?? null, surQ: M.surQ ?? null, peBasis: M.basis ?? (F?.src === 'est' ? 'forward' : null), gOp: M.gOp ?? null, gOpNext: M.gOpNext ?? null, epsNext: M.epsNext ?? null, debtRatio: M.debtRatio ?? null,
      target: F?.target ?? null, upside: F?.upside ?? null };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const sum = { m, at: new Date().toISOString(), rev: SCORE_REV, n: rows.length, weights: WEIGHTS, adjRules: ADJ, peerK: PEER_K,
    funding: rows.reduce((a, x) => { a[x.funding || '미상'] = (a[x.funding || '미상'] || 0) + 1; return a; }, {}),
    peak: rows.filter(x => x.flags.includes('이익 정점 경계')).length, rows };
  await store.set(S_SUM(m), sum);
  return sum;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    if (req.method === 'GET' && (req.query.auto === 'US' || req.query.auto === 'KR')) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      return send(res, 200, await collectChunk(req.query.auto));
    }
    if (req.method === 'GET' && req.query.probe) {                                        // 원응답 확인 (스키마 점검용)
      if (!admin) return send(res, 401, { error: '관리자 키가 필요해' });
      const code = String(req.query.probe);
      if ((req.query.m || 'KR') === 'KR') { const n = normalizeKr(await fetchKrInfo(code)); return send(res, 200, { norm: n, metrics: krMetrics(n) }); }
      return send(res, 200, await fetchForward(code.toUpperCase()));
    }
    if (req.method === 'GET' && req.query.code) {
      const m = req.query.m === 'KR' ? 'KR' : 'US', code = m === 'KR' ? String(req.query.code) : String(req.query.code).toUpperCase();
      const [rec, sum] = await store.mget([KEY(m, code), S_SUM(m)]);
      const scored = sum?.rows?.find(r => r.code === code) || null;
      return rec || scored ? send(res, 200, { ...(rec || {}), scored, rank: scored ? sum.rows.indexOf(scored) + 1 : null, of: sum?.n ?? null }) : send(res, 404, { error: '아직 수집 안 된 종목' });
    }
    if (req.method === 'GET') {
      const m = req.query.m === 'KR' ? 'KR' : 'US';
      let [sum, st] = await store.mget([S_SUM(m), S_STATE(m)]);
      if (sum?.rows && sum.rev !== SCORE_REV && (await store.setNX(`lock:score:${m}`, 1, 120))) {   // 점수 방식이 바뀐 뒤 첫 조회 — 저장된 재료로 다시 매김 (외부 요청 없음)
        try { sum = await scoreAll(m); } catch (e) { console.error('rescore', m, e.message); } finally { await store.del(`lock:score:${m}`); }
      }
      if (sum?.rows) { const so = await loadSecOvr(m); for (const r of sum.rows) if (so[r.code]) r.sector = so[r.code]; }   // 직접 지정한 세부 업종
      const state = st ? { i: st.i, total: st.codes?.length ?? null, done: st.done, started: st.started, updatedAt: st.updatedAt, finishedAt: st.finishedAt || null,
        collected: st.collected ?? null, failedN: st.failed?.length || 0, failed: (st.failed || []).slice(-5), blocked: st.blocked || null,
        next: st.finishedAt ? new Date(Date.parse(st.finishedAt) + (st.blocked ? 864e5 : staleDays(m) * 864e5)).toISOString().slice(0, 10) : null } : null;
      if (req.query.all) return send(res, 200, { summary: sum || null, state, m });
      const top = sum ? { ...sum, rows: sum.rows.slice(0, 25), bottom: sum.rows.slice(-15).reverse() } : null;
      return send(res, 200, { summary: top, state, m });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'POST 만' });
    if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
    const b = await body(req), m = b.m === 'KR' ? 'KR' : 'US';
    if (b.step === 'one') return send(res, 200, await collectOne(m, m === 'KR' ? String(b.code) : String(b.code).toUpperCase()));
    if (b.step === 'collect') return send(res, 200, await collectChunk(m, { reset: !!b.reset }));
    if (b.step === 'score') return send(res, 200, { ...(await scoreAll(m)), rows: undefined });
    send(res, 400, { error: 'step 은 collect | score | one' });
  } catch (e) { send(res, 500, { error: e.message }); }
}
