// 국내 PER·PBR 밴드 → 자기 과거 대비 위치(백분위).
// 밴드 응답: 월말마다 수정주가(ADJ_PRC)와 배수별 밴드선 가격(VALk = 배수k × 그달 EPS·BPS). 미래 달은 주가가 비어 있다.
//   그달 EPS(BPS) = VALk ÷ 배수k (배수가 0 이 아닌 첫 선) → 그달 PER(PBR) = 수정주가 ÷ EPS
//   EPS 가 0(적자·밴드 0) 인 달은 PER 이 없어서 뺀다. PER 이 200 배를 넘는 달(이익 바닥)도 왜곡이 커서 뺀다.
// 자기 백분위 = 지금 배수가 지난 기록(월말) 중 몇 % 위치인가. 0 = 역대 가장 쌈, 100 = 역대 가장 비쌈.
// 경기민감 업종(메모리·화학·철강·조선)과 금융은 이익이 바닥일 때 PER 이 거꾸로 높게 나와서 PBR 을 더 크게 본다.
import { KR_BAND, KR_REFERER, UA, krExtraHeaders } from './sources.js';

export const CYCLICAL = ['메모리', '철강·소재', '화학·정유', '조선', '2차전지', '은행·금융지주', '증권', '보험'];
const MAX_PER = 200, MIN_N = 12;

/** 응답 → { mults:[배수], rows:[{d, p, base, k}] } (k = 그달 배수, 주가 없으면 null) */
export function parseBand(j) {
  const H = j?.dataset?.header || [], D = j?.dataset?.data || [];
  const cols = H.filter(h => /^VAL\d+$/.test(h.ID)).map(h => ({ id: h.ID, x: parseFloat(String(h.NM).replace(/[^\d.]/g, '')) })).filter(c => Number.isFinite(c.x));
  if (!cols.length || !D.length) return null;
  const rows = D.map(r => {
    const c = cols.find(c => c.x > 0 && +r[c.id] > 0);
    const base = c ? +r[c.id] / c.x : null, p = r.ADJ_PRC == null ? null : +r.ADJ_PRC;
    return { d: String(r.TRD_DT || '').replace(/\//g, '-'), p, base, k: p > 0 && base > 0 ? p / base : null };
  });
  return { mults: cols.map(c => c.x), rows };
}

const pctOf = (v, arr) => {
  const s = [...arr].sort((a, b) => a - b);
  let lo = 0; while (lo < s.length && s[lo] < v) lo++;
  let hi = lo; while (hi < s.length && s[hi] === v) hi++;
  return Math.round(100 * ((lo + hi) / 2) / s.length);
};

/**
 * 한 밴드의 통계.
 * @param price 오늘 종가 (없으면 마지막 월말 수정주가)
 * @param kind 'per' | 'pbr'
 */
export function bandStats(B, price, kind) {
  if (!B?.rows?.length) return null;
  const past = B.rows.filter(r => r.p != null);
  if (!past.length) return null;
  const cur = past[past.length - 1];                                    // 이번 달 행 — 그달 EPS·BPS
  const valid = r => r.k != null && (kind !== 'per' || r.k <= MAX_PER);
  const hist = past.filter(valid).map(r => r.k);
  const base = cur.base, px = price ?? cur.p;
  const now = base > 0 && px > 0 ? px / base : null;
  const ok = now != null && (kind !== 'per' || now <= MAX_PER) && hist.length >= MIN_N;
  const sorted = [...hist].sort((a, b) => a - b), q = f => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : null;
  const r2 = x => (x == null ? null : +x.toFixed(2));
  // 1년 뒤 같은 배수면 주가가 어디쯤인가 — 미래 달 EPS(BPS) 가 있으면 (지금 배수 기준 이익 성장분)
  const fut = B.rows.filter(r => r.p == null && r.base > 0), y1 = fut[Math.min(11, fut.length - 1)] || null;
  return {
    now: r2(now), pct: ok ? pctOf(now, hist) : null, n: hist.length, from: past[0].d, to: cur.d,
    min: r2(sorted[0]), med: r2(q(0.5)), max: r2(sorted[sorted.length - 1]), p20: r2(q(0.2)), p80: r2(q(0.8)),
    base: base > 0 ? Math.round(base) : null, loss: !(base > 0), mults: B.mults,
    gBase1y: y1 && base > 0 ? +(100 * (y1.base / base - 1)).toFixed(1) : null,      // 1년 뒤 EPS(BPS) 증가율 (밴드에 반영된 추정)
    hist: past.map(r => (valid(r) ? r2(r.k) : null)).slice(-60),                // 상세 작은 차트용 (월말 배수)
    hd: past.map(r => r.d).slice(-60),
  };
}

/**
 * PER·PBR 을 합친 자기 백분위 (가치 점수의 '자기 과거' 몫).
 * 경기민감·금융은 PBR 75%, 그 외는 PER 60% · PBR 40%. 한쪽만 있으면 그쪽만.
 */
export function bandSelf(per, pbr, theme) {
  const cyc = CYCLICAL.includes(theme);
  const parts = [[per?.pct, cyc ? 0.25 : 0.6], [pbr?.pct, cyc ? 0.75 : 0.4]].filter(([v]) => v != null);
  if (!parts.length) return null;
  const w = parts.reduce((a, [, k]) => a + k, 0);
  return { pct: Math.round(parts.reduce((a, [v, k]) => a + v * k, 0) / w), cyc, basis: parts.length === 2 ? (cyc ? 'PBR 중심' : 'PER 중심') : per?.pct != null ? 'PER 만' : 'PBR 만' };
}

/** 밴드 저장형 — 지난 5년 + 앞으로 1년만 (배수, [날짜, 수정주가, EPS·BPS]) */
export const slimBand = B => ({ mults: B.mults, rows: B.rows.filter(r => r.d >= new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10) && r.d <= new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10))
  .map(r => [r.d, r.p, r.base == null ? null : Math.round(r.base * 100) / 100]) });
const fatBand = b => (b?.rows ? { mults: b.mults, rows: b.rows.map(([d, p, base]) => ({ d, p, base, k: p > 0 && base > 0 ? p / base : null })) } : null);
/** 저장된 밴드 + 오늘 종가 → PER·PBR 자기 위치와 합친 백분위 */
export function bandOf(rec, theme, price = null) {
  const b = rec?.band, px = price ?? rec?.metrics?.price ?? null;
  if (!b?.per && !b?.pbr) return null;
  const per = bandStats(fatBand(b.per), px, 'per'), pbr = bandStats(fatBand(b.pbr), px, 'pbr');
  const self = bandSelf(per, pbr, theme);
  return { per, pbr, self, at: b.at };
}

/** PER(typ 1)·PBR(typ 2) 밴드 원응답 (국내 컨센서스와 같은 제공처 — 헤더도 같게). 빈 응답이면 null */
export async function fetchKrBand(code, typ, consol = 'C', timeoutMs = 15000) {
  const url = `${KR_BAND}?cmp_cd=${encodeURIComponent(code)}&proc_typ=1&chart_typ=${typ}&consol_typ=${consol}`;
  let r;
  try {
    r = await fetch(url, { headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'accept-language': 'ko-KR,ko;q=0.9', 'user-agent': UA,
      referer: `${KR_REFERER}/`, 'x-requested-with': 'XMLHttpRequest', ...krExtraHeaders() }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new Error(`국내 밴드 연결 실패 — ${e.cause?.code || e.name || e.message}`); }
  const txt = (await r.text()).replace(/^﻿/, '').trim();
  if (!r.ok) throw new Error(`국내 밴드 HTTP ${r.status}`);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { throw new Error('국내 밴드 응답이 JSON 이 아님'); }
}
