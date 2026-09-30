// 미국 선행 EPS·선행 PER — 종목 페이지의 요약표(snapshot)에서 읽는다. 주소는 lib/sources.js.
// statement API 에는 컨센서스가 없어서, 'EPS next Y'(달러)·'Forward P/E' 는 여기서만 얻을 수 있다.
// 표 클래스 이름이 바뀌어도 깨지지 않게, td 를 전부 뽑아 라벨→값 순서쌍으로 읽는다.
import { US_QUOTE as Q, UA } from './sources.js';

const LABELS = ['P/E', 'Forward P/E', 'PEG', 'EPS (ttm)', 'EPS next Q', 'EPS this Y', 'EPS next Y', 'EPS next 5Y', 'EPS past 5Y',
  'Sales past 5Y', 'Sales Q/Q', 'EPS Q/Q', 'Target Price', 'Price', 'Inst Own', 'Short Float', 'ROE', 'Oper. Margin',
  'Profit Margin', 'Recom', 'Beta', 'Market Cap', 'Income', 'Sales', 'Book/sh', 'Cash/sh', 'Dividend TTM'];

const strip = s => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
const numOf = s => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '-' || t === '—') return null;
  const mul = /B$/i.test(t) ? 1e3 : /M$/i.test(t) ? 1 : /K$/i.test(t) ? 1e-3 : 1;   // 금액은 백만 단위로 통일
  const x = parseFloat(t);
  return Number.isFinite(x) ? (/[BMK]$/i.test(t) ? x * mul : x) : null;
};
const isPct = s => /%\s*$/.test(String(s || ''));

/** 요약표 HTML → { 라벨: [값문자열...] } */
export function parseSnapshot(html) {
  const cells = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(html))) cells.push(strip(m[1]));
  const out = {};
  for (let i = 0; i < cells.length - 1; i++) {
    const L = cells[i];
    if (!LABELS.includes(L)) continue;
    const v = cells[i + 1];
    if (v == null || LABELS.includes(v)) continue;
    (out[L] = out[L] || []).push(v);
  }
  return out;
}

export async function fetchForward(ticker, { timeoutMs = 15000 } = {}) {
  const url = `${Q}?t=${encodeURIComponent(ticker)}&p=d`;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`미국 선행지표 HTTP ${r.status}`);
  const snap = parseSnapshot(await r.text());
  if (!Object.keys(snap).length) throw new Error('미국 선행지표 요약표를 못 읽었어 (페이지 구조 변경?)');
  return forwardOf(snap);
}

/** 요약표 → 선행 지표. 'EPS next Y' 는 달러(추정치)와 %(성장률)가 같은 이름으로 둘 다 나온다 */
export function forwardOf(s) {
  const one = (k, i = 0) => (s[k] || [])[i] ?? null;
  const all = k => s[k] || [];
  const dollar = k => { const v = all(k).find(x => !isPct(x)); return numOf(v); };
  const percent = k => { const v = all(k).find(x => isPct(x)); return numOf(v); };

  const price = numOf(one('Price')), epsTtm = numOf(one('EPS (ttm)')), fwdPe = numOf(one('Forward P/E'));
  let epsNextY = dollar('EPS next Y');
  const gNextY = percent('EPS next Y'), gThisY = percent('EPS this Y');
  if (epsNextY == null && price != null && fwdPe) epsNextY = +(price / fwdPe).toFixed(3);          // 선행 PER 로 역산
  if (epsNextY == null && epsTtm != null && gNextY != null) epsNextY = +(epsTtm * (1 + gNextY / 100)).toFixed(3);

  const target = numOf(one('Target Price'));
  return {
    ok: epsNextY != null || fwdPe != null,
    price, epsTtm, epsNextY, fwdPe: fwdPe ?? (price != null && epsNextY ? +(price / epsNextY).toFixed(2) : null),
    pe: numOf(one('P/E')), peg: numOf(one('PEG')),
    gEpsThisY: gThisY, gEpsNextY: gNextY, gEps5Y: percent('EPS next 5Y'),
    epsQQ: percent('EPS Q/Q'), salesQQ: percent('Sales Q/Q'),
    target, upside: target != null && price ? +(100 * (target / price - 1)).toFixed(1) : null,
    instOwn: percent('Inst Own'), shortFloat: percent('Short Float'), recom: numOf(one('Recom')),
    at: new Date().toISOString(),
  };
}

/** 선행 지표를 대장 점수 축에 얹기 — 값이 없으면 기존 과거 기반 점수를 그대로 둔다 */
export function blendForward(raw, f) {
  if (!f?.ok) return raw;
  const out = { ...raw };
  if (f.gEpsNextY != null) out.growth = f.gEpsNextY;                                  // 과거 TTM 성장 → 선행 성장으로 교체
  if (f.gEpsNextY != null && f.gEpsThisY != null) out.accel = f.gEpsNextY - f.gEpsThisY;   // 선행 가속도
  if (f.fwdPe != null && f.fwdPe > 0) {
    const v = -Math.log(f.fwdPe);                                                     // 선행 PER 이 낮으면 +
    out.value = out.value == null ? v : (out.value + v) / 2;                          // 자기 과거 대비 + 절대 밸류 절반씩
  }
  return out;
}
