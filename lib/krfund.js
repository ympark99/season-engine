// 국내 컨센서스(대장 엔진 재료) — 연간(실적 3년 + 추정 3년)과 분기(실적 3분기 + 추정 3분기) 표를 받아
// 미국과 같은 7개 원점수로 환산한다. 제공처 이름은 화면·코드 어디에도 쓰지 않는다 (주소는 lib/sources.js).
//
// 응답: { dataset: { header:[{YYMM:'2026/12', EP_CHK:'E', CD:'VAL4'}...], data:[{NAME, AC_CODE, P_AC_CODE, LVL, VAL1..VAL6}...] } }
//   계정은 이름이 아니라 AC_CODE 로 찾는다 (이름 공백·표기가 바뀌어도 안전).
//   LVL 2 행은 바로 위 LVL 1 계정의 '전년동기대비'·'컨센서스대비'(%) — 이름에 '컨센서스'가 있으면 서프라이즈.
// 추정치 변경 이력은 응답에 없어서, 수집할 때마다 추정 EPS 를 기록(hist)해 두고 그 변화로 '추정 상향/하향'을 만든다.
import { KR_CNS, KR_REFERER, UA, krExtraHeaders } from './sources.js';

const AC = {
  rev: '121000', op: '121450', np: '122700', npc: '122710',
  assets: '111000', debt: '113000', equity: '115000', equityC: '115020',
  eps: '312000', bps: '314000', dps: '423400', per: '382100', pbr: '382500',
};

async function getTable(code, freq, timeoutMs) {
  const url = `${KR_CNS}?cmp_cd=${encodeURIComponent(code)}&consol_typ=C&freq_typ=${freq}&data_typ=2`;
  let r;
  try {
    r = await fetch(url, {
      headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'accept-language': 'ko-KR,ko;q=0.9', 'user-agent': UA,
        referer: `${KR_REFERER}/`, 'x-requested-with': 'XMLHttpRequest', ...krExtraHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw new Error(`국내 컨센서스 연결 실패 — ${e.cause?.code || e.name || e.message}`); }
  const txt = (await r.text()).replace(/^﻿/, '');
  if (!r.ok) {
    const why = r.status === 401 ? '로그인·토큰 필요' : r.status === 403 ? '접근 차단(서버 IP 차단 가능성)' : r.status === 429 ? '요청 과다' : '';
    throw new Error(`국내 컨센서스 HTTP ${r.status}${why ? ' — ' + why : ''} ${txt.slice(0, 60)}`);
  }
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`국내 컨센서스 응답이 JSON 이 아님 (${txt.slice(0, 60)})`); }
  if (!j?.dataset?.header || !j?.dataset?.data) throw new Error('국내 컨센서스 응답 형식이 달라 (dataset 없음)');
  return j;
}

/** 연간·분기 둘 다 받는다. 분기가 실패해도 연간만으로 진행 */
export async function fetchKrInfo(code, { timeoutMs = 15000, gapMs = 250 } = {}) {
  const Y = await getTable(code, 'Y', timeoutMs);
  let Q = null;
  try { await new Promise(r => setTimeout(r, gapMs)); Q = await getTable(code, 'Q', timeoutMs); } catch { Q = null; }
  return { Y, Q };
}

const num = v => {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : +String(v).replace(/[, %]/g, '');
  return Number.isFinite(x) ? x : null;
};

/** 표 하나 → 기간 배열 [{ p:'2026/12', y:2026, m:12, est:true, rev, op, ..., yoy:{rev,op,np}, sur:{rev,op,np} }] */
export function parseTable(j) {
  const H = j?.dataset?.header || [], D = j?.dataset?.data || [];
  const out = H.map(h => {
    const [yy, mm] = String(h.YYMM || '').split('/');
    return { p: h.YYMM, y: +yy || null, m: +mm || null, est: String(h.EP_CHK || '').trim() === 'E', cd: h.CD, yoy: {}, sur: {} };
  });
  let parent = null;
  for (const row of D) {
    const lvl = +row.LVL, name = String(row.NAME || '');
    if (lvl === 1) {
      parent = Object.entries(AC).find(([, c]) => c === String(row.AC_CODE))?.[0] || null;
      if (!parent) continue;
      for (const o of out) o[parent] = num(row[o.cd]);
    } else if (lvl === 2 && parent && ['rev', 'op', 'np'].includes(parent)) {
      const slot = name.includes('컨센서스') ? 'sur' : name.includes('전년') ? 'yoy' : null;
      if (slot) for (const o of out) o[slot][parent] = num(row[o.cd]);
    }
  }
  return out.filter(o => o.y).map(({ cd, ...o }) => o);
}

/** 응답 → 필요한 것만 추린 표준형 (기록 hist 는 수집 쪽에서 이어 붙인다) */
export function normalizeKr({ Y, Q } = {}) {
  const yearly = Y ? parseTable(Y) : [], quarterly = Q ? parseTable(Q) : [];
  return { yearly, quarterly, at: new Date().toISOString() };
}

const rel = (a, b) => (a == null || b == null || Math.abs(b) < 1e-9 ? null : Math.max(-3, Math.min(3, (a - b) / Math.abs(b))));
const r1 = v => (v == null ? null : +v.toFixed(1));

/** 이번 수집의 추정 EPS 스냅샷 — hist 에 쌓아서 추정 변화율을 계산 */
export function epsSnapshot(n) {
  const e = {};
  for (const r of n.yearly) if (r.est && r.eps != null) e[r.y] = r.eps;
  return { d: new Date().toISOString().slice(0, 10), eps: e };
}

/** 추정 변화율(%) — 같은 연도 추정 EPS 가 20~91일 전 기록 대비 얼마나 바뀌었나 */
function revisionOf(hist, year, now) {
  if (!hist?.length || now == null || !year) return null;
  const today = Date.now(), old = hist.filter(h => h.eps?.[year] != null && today - Date.parse(h.d) >= 20 * 864e5 && today - Date.parse(h.d) <= 91 * 864e5);
  if (!old.length) return null;
  const base = old.sort((a, b) => (a.d < b.d ? -1 : 1))[0].eps[year];
  const g = rel(now, base);
  return g == null ? null : +(100 * g).toFixed(1);
}

/**
 * 국내 지표. price 는 저장된 일봉의 마지막 종가(없으면 추정 PER×EPS 로 역산).
 * 선행 EPS 는 12개월 앞 기준 — 올해 추정과 내년 추정을 남은 개월 수로 섞는다.
 */
export function krMetrics(n, { price = null, hist = [], asOf = null } = {}) {
  const now = asOf ? new Date(asOf) : new Date();
  const Yn = now.getUTCFullYear(), Mn = now.getUTCMonth() + 1;
  const Yr = n.yearly;
  const y0 = Yr.find(r => r.y === Yn) || Yr.find(r => r.est) || null;                    // 올해(대개 추정)
  const y1 = y0 ? Yr.find(r => r.y === y0.y + 1) : null;                                   // 내년 추정
  const yP = y0 ? Yr.find(r => r.y === y0.y - 1) : null;                                   // 작년 실적
  if (!y0 || y0.eps == null) return { ok: false, why: '연간 추정치 없음' };

  const w = Math.max(0, Math.min(1, (12 - Mn) / 12));                                      // 올해 남은 비중
  const fwdEps = y1?.eps != null ? w * y0.eps + (1 - w) * y1.eps : y0.eps;
  const px = price ?? (y0.per != null ? y0.per * y0.eps : null);
  const fwdPe = px != null && fwdEps > 0 ? +(px / fwdEps).toFixed(2) : null;

  const gThis = rel(y0.eps, yP?.eps), gFwd = rel(y1?.eps, y0.eps);
  const omOf = r => (r?.rev ? 100 * (r.op ?? 0) / r.rev : null);
  const om0 = omOf(y0), om1 = omOf(y1);

  // 분기 — 가장 최근 실적 분기의 서프라이즈와, 실적→다음 추정 분기의 영업이익 YoY 변화
  const Qs = n.quarterly || [];
  const lastA = [...Qs].reverse().find(q => !q.est) || null, nextE = Qs.find(q => q.est) || null;
  const surOp = lastA?.sur?.op ?? null, surNp = lastA?.sur?.np ?? null;
  const qAccel = lastA?.yoy?.op != null && nextE?.yoy?.op != null ? nextE.yoy.op - lastA.yoy.op : null;

  const revUp = revisionOf(hist, y1?.y ?? y0.y, y1?.eps ?? y0.eps);
  const roeFwd = y1?.npc != null && y0?.equityC ? +(100 * y1.npc / y0.equityC).toFixed(1) : (y0?.npc != null && yP?.equityC ? +(100 * y0.npc / yP.equityC).toFixed(1) : null);
  const debtRatio = y0?.debt != null && y0?.equity ? +(100 * y0.debt / y0.equity).toFixed(1) : null;

  return {
    ok: true, src: 'KR', asOf: now.toISOString().slice(0, 10), price: px,
    yThis: y0.y, yNext: y1?.y ?? null, epsThis: y0.eps, epsNext: y1?.eps ?? null, fwdEps: +fwdEps.toFixed(0), fwdPe,
    peThis: y0.per ?? null, pbr: y1?.pbr ?? y0.pbr ?? null, roeFwd, debtRatio,
    gEps: gThis == null ? null : r1(100 * gThis), gEpsFwd: gFwd == null ? null : r1(100 * gFwd),
    gRev: r1(y0.yoy?.rev ?? null), gOp: r1(y0.yoy?.op ?? null), gOpNext: r1(y1?.yoy?.op ?? null),
    accelEps: gFwd != null && gThis != null ? r1(100 * (gFwd - gThis)) : null,
    qAccel: r1(qAccel), surOp: r1(surOp), surNp: r1(surNp), surQ: lastA?.p ?? null,
    revUp, revN: hist?.length || 0,
    om: r1(om0), dOm: om0 != null && om1 != null ? r1(om1 - om0) : null,
    noisy: !!(yP?.eps != null && Math.abs(yP.eps) < 100),
  };
}

/** 미국과 같은 7축 원점수 — 백분위는 부르는 쪽에서 매긴다 */
export function krRawScores(m) {
  if (!m?.ok) return null;
  const clip = (v, a) => (v == null ? null : Math.max(-a, Math.min(a, v)));
  // 가속: 추정 상향이 쌓였으면 그걸, 아니면 성장률 변화(내년-올해). 직전 분기 서프라이즈를 절반 가중으로 더한다.
  const base = m.revUp != null ? clip(m.revUp, 50) * 4 : clip(m.accelEps, 300);
  const accel = base == null && m.surOp == null ? null : (base ?? 0) + 0.5 * (clip(m.surOp, 60) ?? 0);
  return {
    accel,
    growth: clip(m.gEpsFwd ?? m.gEps, 300),
    margin: m.dOm,                                          // 영업이익률 추정 변화 (내년 - 올해)
    cash: null,                                             // 컨센서스 표에 현금흐름이 없음
    quality: m.roeFwd,
    value: m.fwdPe != null && m.fwdPe > 0 ? -Math.log(m.fwdPe) : null,   // 선행 PER 이 낮으면 +
    risk: m.debtRatio != null ? -m.debtRatio : null,       // 부채비율이 낮을수록 +
  };
}
