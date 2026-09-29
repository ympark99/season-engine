// 국내 추정실적(대장 엔진 재료). 외부 제공처 응답을 받아 미국(Finviz)과 같은 7개 원점수로 환산한다.
// 제공처 이름은 화면 어디에도 쓰지 않는다. 주소는 환경변수로 바꿔 끼울 수 있게 해둔다.
// 응답 구조가 조금 달라도 깨지지 않도록, 키 이름을 깊이 탐색해서 찾는 방식으로 읽는다.
const BASE = process.env.KR_FUND_BASE || 'https://stockeasy.intellio.kr/stockdata/api/v1/stock-info-v2';
const UA = process.env.KR_FUND_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

export async function fetchKrInfo(code, { timeoutMs = 15000 } = {}) {
  const url = `${BASE}/${encodeURIComponent(code)}/info`;
  const r = await fetch(url, {
    headers: { accept: 'application/json, text/plain, */*', 'accept-language': 'ko-KR,ko;q=0.9', 'user-agent': UA, referer: 'https://stockeasy.intellio.kr/', origin: 'https://stockeasy.intellio.kr' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`국내 추정실적 HTTP ${r.status} ${txt.slice(0, 120)}`);
  try { return JSON.parse(txt); } catch { throw new Error('국내 추정실적 응답이 JSON 이 아님'); }
}

/* ------------------------- 구조에 안 휘둘리는 읽기 도우미 ------------------------- */
/** 객체 어디에 있든 이름이 맞는 첫 값을 찾는다 (대소문자·밑줄 무시) */
export function deepFind(obj, names, want = 'any', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  const norm = s => String(s).toLowerCase().replace(/[_\s-]/g, '');
  const keys = names.map(norm);
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(norm(k)) && v != null) {
      if (want === 'array' && !Array.isArray(v)) continue;
      if (want === 'object' && (Array.isArray(v) || typeof v !== 'object')) continue;
      return v;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const r = deepFind(v, names, want, depth + 1); if (r != null) return r; }
  }
  return null;
}
const num = v => {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : +String(v).replace(/[, %]/g, '');
  return Number.isFinite(x) ? x : null;
};
/** 행에서 별칭 목록 중 먼저 걸리는 숫자 */
const pick = (row, aliases) => {
  if (!row || typeof row !== 'object') return null;
  const norm = s => String(s).toLowerCase().replace(/[_\s-]/g, '');
  const map = {}; for (const [k, v] of Object.entries(row)) map[norm(k)] = v;
  for (const a of aliases) { const v = num(map[norm(a)]); if (v != null) return v; }
  return null;
};
const yearOf = row => {
  const raw = pick(row, ['year', 'yyyy', 'fiscalYear', 'bsnsYear', 'settlementYear']) ??
    num(String(deepFind(row, ['period', 'date', 'ym', 'yearMonth', 'settlementDate']) || '').slice(0, 4));
  return raw && raw > 1990 && raw < 2100 ? Math.round(raw) : null;
};

/** 응답 → 필요한 것만 추린 표준형 */
export function normalizeKr(j) {
  const root = j?.data && typeof j.data === 'object' ? j.data : j;
  const yArr = deepFind(root, ['consolidatedYearlyEstimate', 'yearlyEstimate', 'annualEstimate'], 'array') || [];
  const qArr = deepFind(root, ['consolidatedEstimate', 'quarterlyEstimate'], 'array') || [];
  const rev = deepFind(root, ['epsChanges', 'eps_changes', 'estimateChanges'], 'array') || [];
  const rs = deepFind(root, ['rsData', 'rs_data'], 'object') || {};
  const inv = deepFind(root, ['investment', 'investmentIndicator', 'grades'], 'object') || {};
  const sec = deepFind(root, ['sectorInfo', 'sector_info'], 'object') || {};
  const price = num(deepFind(root, ['currentPrice', 'closePrice', 'price', 'lastPrice'])) ?? null;

  const yearly = (Array.isArray(yArr) ? yArr : Object.values(yArr)).map(r => ({
    y: yearOf(r),
    eps: pick(r, ['eps', 'epsEstimate', 'estimateEps']),
    per: pick(r, ['per', 'pe', 'perEstimate']),
    roe: pick(r, ['roe']),
    bps: pick(r, ['bps']), pbr: pick(r, ['pbr', 'pb']),
    rev: pick(r, ['revenue', 'sales', 'salesAmount', 'mag']),
    op: pick(r, ['operatingProfit', 'opProfit', 'operatingIncome', 'yg']),
    np: pick(r, ['netProfit', 'netIncome', 'dg']),
    n: pick(r, ['estimateCount', 'analystCount', 'cnt']),
  })).filter(r => r.y).sort((a, b) => a.y - b.y);

  const quarterly = (Array.isArray(qArr) ? qArr : Object.values(qArr)).map(r => ({
    q: String(deepFind(r, ['period', 'quarter', 'ym', 'yearMonth', 'date']) || ''),
    eps: pick(r, ['eps']), rev: pick(r, ['revenue', 'sales', 'mag']), op: pick(r, ['operatingProfit', 'yg']),
  })).filter(r => r.q);

  const revisions = (Array.isArray(rev) ? rev : Object.values(rev)).map(r => ({
    d: String(deepFind(r, ['changeDate', 'change_date', 'date', 'ymd']) || '').slice(0, 10),
    old: pick(r, ['valueOld', 'value_old', 'before', 'prev']),
    cur: pick(r, ['valueNew', 'value_new', 'after', 'value']),
    chg: pick(r, ['changeRate', 'change_rate', 'rate', 'pct']),
    y: yearOf(r),
  })).filter(r => r.d).sort((a, b) => (a.d < b.d ? 1 : -1));

  return {
    price, yearly, quarterly, revisions,
    rs: { rs: pick(rs, ['rs', 'rsScore', 'value']), m1: pick(rs, ['rs1m', 'rs_1m']), m3: pick(rs, ['rs3m', 'rs_3m']), m6: pick(rs, ['rs6m', 'rs_6m']) },
    grades: { growth: pick(inv, ['growth', 'growthGrade']), profit: pick(inv, ['profitability', 'profit', 'profitGrade']), stability: pick(inv, ['stability', 'stabilityGrade']), value: pick(inv, ['valuation', 'value', 'valueGrade']) },
    sector: String(deepFind(sec, ['name', 'sectorName', 'sector']) || '') || null,
  };
}

const rel = (a, b) => (a == null || b == null || Math.abs(b) < 1e-9 ? null : Math.max(-3, Math.min(3, (a - b) / Math.abs(b))));

/**
 * 국내 지표 — 선행 EPS(올해·내년), 선행 PER, 추정 상향 모멘텀.
 * 미국 지표와 같은 자리(accel/growth/margin/cash/quality/value/risk)에 넣을 수 있게 맞춰 놓는다.
 */
export function krMetrics(n, { asOf = null } = {}) {
  const Y = new Date((asOf ? Date.parse(asOf) : Date.now())).getUTCFullYear();
  const y0 = n.yearly.find(r => r.y === Y) || n.yearly.find(r => r.y >= Y) || null;      // 올해(당해 추정)
  const y1 = n.yearly.find(r => r.y === (y0?.y ?? Y) + 1) || null;                        // 내년
  const yPrev = n.yearly.find(r => r.y === (y0?.y ?? Y) - 1) || null;                     // 작년(실적)
  if (!y0 && !y1) return { ok: false, why: '추정치 없음' };

  const fwdEps = y1?.eps ?? y0?.eps ?? null;
  const fwdPe = y1?.per ?? y0?.per ?? (n.price && fwdEps ? +(n.price / fwdEps).toFixed(2) : null);
  const gFwd = rel(y1?.eps, y0?.eps);                       // 내년/올해 EPS 성장
  const gThis = rel(y0?.eps, yPrev?.eps);                   // 올해/작년 EPS 성장
  const accel = gFwd != null && gThis != null ? +(100 * (gFwd - gThis)).toFixed(1) : null;

  // 추정 상향 모멘텀 — 최근 90일 변경 이력의 변화율 합 (상향이 쌓이면 +)
  const cut = new Date((asOf ? Date.parse(asOf) : Date.now()) - 90 * 864e5).toISOString().slice(0, 10);
  const recent = n.revisions.filter(r => r.d >= cut && (!asOf || r.d <= asOf));
  const revUp = recent.length
    ? +recent.reduce((a, r) => a + (r.chg != null ? Math.max(-50, Math.min(50, r.chg)) : (rel(r.cur, r.old) ?? 0) * 100), 0).toFixed(2)
    : null;
  const revN = recent.length;

  const omNow = y0?.rev ? 100 * (y0.op ?? 0) / y0.rev : null;
  const omNext = y1?.rev ? 100 * (y1.op ?? 0) / y1.rev : null;

  return {
    ok: true, src: 'KR', asOf: asOf || new Date().toISOString().slice(0, 10),
    yThis: y0?.y ?? null, yNext: y1?.y ?? null, price: n.price,
    epsThis: y0?.eps ?? null, epsNext: y1?.eps ?? null, fwdEps, fwdPe,
    peThis: y0?.per ?? null, roeFwd: y1?.roe ?? y0?.roe ?? null, pbr: y1?.pbr ?? y0?.pbr ?? null,
    gEps: gThis == null ? null : +(100 * gThis).toFixed(1),
    gEpsFwd: gFwd == null ? null : +(100 * gFwd).toFixed(1),
    gRev: rel(y1?.rev, y0?.rev) == null ? null : +(100 * rel(y1.rev, y0.rev)).toFixed(1),
    accelEps: accel, revUp, revN,
    om: omNow == null ? null : +omNow.toFixed(1), dOm: omNow != null && omNext != null ? +(omNext - omNow).toFixed(1) : null,
    rs: n.rs.rs ?? null, rs3m: n.rs.m3 ?? null, grades: n.grades, sector: n.sector,
    coverage: y1?.n ?? y0?.n ?? null,
    noisy: !!(y0?.eps != null && yPrev?.eps != null && Math.abs(yPrev.eps) < 50),
  };
}

/** 미국과 같은 7축 원점수 — 백분위는 부르는 쪽에서 매긴다 */
export function krRawScores(m) {
  if (!m?.ok) return null;
  return {
    accel: m.revUp ?? m.accelEps ?? null,                  // 추정 상향(=이익 정점의 반대 신호)
    growth: m.gEpsFwd ?? m.gEps ?? null,                   // 선행 EPS 성장률
    margin: m.dOm,                                          // 영업이익률 추정 변화
    cash: null,                                             // 국내 응답에 현금흐름이 없음
    quality: m.roeFwd,
    value: m.fwdPe != null && m.fwdPe > 0 ? -Math.log(m.fwdPe) : null,   // 선행 PER 이 낮으면 +
    risk: m.coverage != null ? Math.min(10, m.coverage) / 10 : 0,        // 추정 기관 수가 적으면 신뢰도 낮음
  };
}
