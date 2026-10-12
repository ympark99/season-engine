// 매출 흐름도 — "누가 이 회사 물건을 사 주나(주요 매출처) → 이 회사 → 어느 사업·자회사에서 매출이 나오나" + 손익 흐름(매출 → 원가 → 영업이익 → 순이익).
// 상세 화면에서 [매출 흐름도 열기]를 누를 때만 만들고 flow:{m}:{code} 에 7일 저장 (저장소 조사 결과가 새로 올라오면 바로 다시 만듦).
//
// 매출처·사업 구성은 아래 우선순위로 채운다.
//   ① 관리자가 화면에서 고친 값(flow:ovr:{m}:{code})
//   ② 조사 결과 — [매출처 조사 예약]을 누르면 flow:queue 에 쌓이고, 매일 아침 매크로 정기 작업(Claude)이 ?flow=queue 로 목록을 읽어
//      공시·실적 발표·보도·검색으로 조사한 뒤 public/data/flows/{m}_{code}.json 과 index.json 을 저장소에 올린다. 비공개 거래처는 '추정'으로 표시.
//   ③ 처음 만든 정리표(아래 MAP) — 공시로 하나씩 확인하지 않은 항목이 섞여 있음
//   ④ 셋 다 없으면 섹터 사슬(SECTOR_CUST)로 '보통 이 업종의 고객' — '섹터 추정' 표시
// 손익은 미국 = 최근 4분기 합(TTM, 백만 달러), 국내 = 컨센서스 표의 최근 실적 연도(억원, 매출원가 없음 → 영업비용으로 묶음).
import * as store from './store.js';

export const FLOW_V = 2;
// 정기 작업(매일 아침 매크로 갱신 때 같이 도는 Claude 작업)이 조사해서 저장소에 올린 흐름도 — public/data/flows/{m}_{code}.json, 목록은 index.json
const REPO = process.env.FLOW_REPO_URL || 'https://raw.githubusercontent.com/ympark99/season-engine/main/public/data/flows/';
const QKEY = 'flow:queue', QMAX = 60;

/** 저장소 목록 {"KR:131290": {at, name}} — 15분 캐시 (없으면 빈 목록) */
export async function repoIndex() {
  const c = await store.get('flow:repoidx');
  if (c && Date.now() - Date.parse(c.fetched) < 15 * 60e3) return c.idx;
  let idx = c?.idx || {};
  try { const r = await fetch(`${REPO}index.json?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) }); if (r.ok) idx = await r.json(); else if (r.status === 404) idx = {}; } catch { /* 지난 값 유지 */ }
  await store.set('flow:repoidx', { fetched: new Date().toISOString(), idx });
  return idx;
}
async function repoFlow(m, code) {
  try { const r = await fetch(`${REPO}${m}_${encodeURIComponent(code)}.json?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** 분석 예약 — 다음 정기 작업 때 조사. update=true 면 이미 있는 흐름도를 다시 조사 */
export async function enqueue(m, code, { name, theme, update } = {}) {
  const q = (await store.get(QKEY)) || {}, k = `${m}:${code}`;
  if (!q[k] && Object.keys(q).length >= QMAX) throw new Error(`예약이 ${QMAX}건 밀려 있어 — 정기 작업이 처리한 뒤 다시`);
  q[k] = { m, code, name: String(name || code).slice(0, 40), theme: theme || null, at: new Date().toISOString(), update: !!update };
  await store.set(QKEY, q);
  return q[k];
}
export const queue = async () => (await store.get(QKEY)) || {};
async function dequeue(k) { const q = await queue(); if (q[k]) { delete q[k]; await store.set(QKEY, q); } }
const U = (code, name) => ({ code, m: 'US', name });
const K = (code, name) => ({ code, m: 'KR', name });

/** 고객 묶음 — 섹터 사슬과 직접 표에서 같이 쓴다 */
export const GROUPS = {
  hyper: { name: '하이퍼스케일러', items: [U('MSFT', 'Microsoft Azure'), U('AMZN', 'Amazon AWS'), U('GOOGL', 'Google Cloud'), U('META', 'Meta'), U('ORCL', 'Oracle OCI')] },
  neo: { name: '네오클라우드', items: [U('CRWV', 'CoreWeave'), U('NBIS', 'Nebius'), U('IREN', 'IREN')] },
  mem3: { name: '메모리 3사', items: [K('000660', 'SK하이닉스'), K('005930', '삼성전자'), U('MU', 'Micron')] },
  aisemi: { name: 'AI 반도체', items: [U('NVDA', 'NVIDIA'), U('AMD', 'AMD'), U('AVGO', 'Broadcom')] },
  server: { name: 'AI 서버', items: [U('DELL', 'Dell'), U('SMCI', 'Supermicro'), U('HPE', 'HPE')] },
  foundry: { name: '파운드리', items: [U('TSM', 'TSMC'), K('005930', '삼성 파운드리'), U('INTC', 'Intel')] },
  dc: { name: '데이터센터·코로케이션', items: [U('EQIX', 'Equinix'), U('DLR', 'Digital Realty')] },
  util: { name: '전력회사', items: [U('NEE', 'NextEra'), U('DUK', 'Duke'), U('SO', 'Southern')] },
  oem: { name: '스마트폰·PC 제조사', items: [U('AAPL', 'Apple'), K('005930', '삼성 MX'), U('HPQ', 'HP')] },
  auto: { name: '자동차·산업', items: [U('TSLA', 'Tesla'), K('005380', '현대차')] },
  net: { name: '네트워크 장비', items: [U('ANET', 'Arista'), U('CSCO', 'Cisco')] },
};

/** 섹터 → 보통의 매출처 묶음 (직접 표가 없을 때) */
const SECTOR_CUST = {
  'AI 반도체': ['hyper', 'server', 'neo'], '메모리': ['aisemi', 'hyper', 'oem'], '반도체 전공정': ['mem3', 'foundry'], '반도체 후공정': ['mem3', 'aisemi'],
  '반도체 기판·PCB': ['aisemi', 'net'], '팹리스·파운드리': ['aisemi', 'oem'], '아날로그 반도체': ['auto', 'oem'], '광통신·네트워크': ['hyper', 'aisemi'],
  '네오클라우드': ['hyper'], 'AI 서버': ['hyper', 'neo'], '전력 인프라': ['dc', 'util'], '전력기기': ['util', 'dc'], '데이터센터 냉각': ['dc', 'hyper'],
  '원전·SMR': ['util', 'hyper'], 'AI 소프트웨어': [], '전자·부품': ['oem', 'auto'], '2차전지': ['auto'],
};

const C = (x, extra = {}) => ({ ...x, ...extra });
/**
 * 직접 정리한 표. cust: 매출처(share = 매출 대비 %, 공시된 것만), segs: 사업부·자회사(매출이 흘러 나가는 곳 — 오른쪽), note: 출처 메모.
 * src: '공시' = 사업보고서·10-K·실적 발표에 나온 사실, '업계' = 업계·리포트에서 널리 알려진 관계(비중 미공시)
 */
const MAP = {
  'US:NVDA': {
    cust: [C(GROUPS.hyper, { share: 50, src: '실적 발표', note: 'FY26 4분기 실적 발표 — 상위 5개 클라우드·하이퍼스케일러가 매출의 50% 남짓' }),
      { name: '직접 고객 2곳 (서버 ODM 등)', share: 36, src: '10-K', note: 'FY26 10-K — 직접 고객 2곳 합계 36% (이름 비공개, 대부분 서버 조립사)' },
      C(GROUPS.neo, { src: '업계' }), C(GROUPS.server, { src: '업계' })],
    segs: [{ name: '데이터센터', amt: 193700, note: 'FY26' }, { name: '게이밍·프로·자동차', amt: 22200, note: 'FY26' }], unitSeg: 'M$',
  },
  'US:AMD': { cust: [C(GROUPS.hyper, { src: '업계' }), C(GROUPS.oem, { src: '업계' })], segs: [{ name: '데이터센터' }, { name: '클라이언트·게이밍' }, { name: '임베디드' }] },
  'US:AVGO': { cust: [{ ...U('GOOGL', 'Google (TPU)'), src: '업계' }, { ...U('META', 'Meta (ASIC)'), src: '업계' }, { ...U('AAPL', 'Apple (무선칩)'), src: '업계' }], segs: [{ name: '반도체 솔루션' }, { name: '인프라 소프트웨어(VMware)' }] },
  'US:MU': { cust: [{ ...U('NVDA', 'NVIDIA (HBM)'), src: '업계' }, C(GROUPS.hyper, { src: '업계' }), C(GROUPS.oem, { src: '업계' })], segs: [{ name: '클라우드 메모리(HBM·서버)' }, { name: '모바일·PC' }, { name: '자동차·임베디드' }] },
  'US:TSM': { cust: [{ ...U('NVDA', 'NVIDIA'), src: '업계' }, { ...U('AAPL', 'Apple'), src: '업계' }, { ...U('AMD', 'AMD'), src: '업계' }, { ...U('AVGO', 'Broadcom'), src: '업계' }], segs: [{ name: 'HPC(AI·서버)' }, { name: '스마트폰' }, { name: 'IoT·자동차' }] },
  'US:ANET': { cust: [{ ...U('MSFT', 'Microsoft'), src: '10-K' }, { ...U('META', 'Meta'), src: '10-K' }, C(GROUPS.hyper, { name: '그 밖의 클라우드', src: '업계' })], segs: [{ name: '데이터센터 스위치' }, { name: '캠퍼스·라우팅' }] },
  'US:SMCI': { cust: [C(GROUPS.neo, { src: '업계' }), { name: 'xAI 등 AI 기업', src: '업계' }, C(GROUPS.hyper, { src: '업계' })], segs: [{ name: 'AI GPU 서버' }] },
  'US:DELL': { cust: [C(GROUPS.neo, { src: '업계' }), { name: 'xAI 등 AI 기업', src: '업계' }, { name: '기업 고객', src: '업계' }], segs: [{ name: 'ISG(서버·스토리지)' }, { name: 'CSG(PC)' }] },
  'US:VRT': { cust: [C(GROUPS.hyper, { src: '업계' }), C(GROUPS.dc, { src: '업계' })], segs: [{ name: '전력 관리' }, { name: '열 관리(냉각)' }, { name: '서비스' }] },
  'US:LITE': { cust: [C(GROUPS.hyper, { src: '업계' }), { ...U('NVDA', 'NVIDIA'), src: '업계' }], segs: [{ name: '클라우드·네트워킹(광모듈·레이저)' }, { name: '산업·기타' }] },
  'US:COHR': { cust: [C(GROUPS.hyper, { src: '업계' }), { ...U('NVDA', 'NVIDIA'), src: '업계' }], segs: [{ name: '데이터센터·통신(트랜시버)' }, { name: '산업용 레이저·소재' }] },
  'US:CRDO': { cust: [{ ...U('AMZN', 'Amazon'), src: '업계' }, C(GROUPS.hyper, { name: '그 밖의 하이퍼스케일러', src: '업계' })], segs: [{ name: 'AEC(구리 케이블)' }, { name: 'SerDes·광 DSP' }] },
  'US:ALAB': { cust: [C(GROUPS.hyper, { src: '업계' }), { ...U('NVDA', 'NVIDIA 생태계'), src: '업계' }], segs: [{ name: 'PCIe·CXL 연결칩' }] },
  'KR:000660': { cust: [{ ...U('NVDA', 'NVIDIA (HBM)'), src: '업계' }, C(GROUPS.hyper, { name: '하이퍼스케일러 (ASIC·서버 D램)', src: '업계' }), C(GROUPS.oem, { src: '업계' })], segs: [{ name: 'D램(HBM 포함)' }, { name: '낸드(솔리다임 포함)' }] },
  'KR:005930': { cust: [{ name: 'Apple · Deutsche Telekom · Hong Kong Techtronics · Supreme Electronics · Verizon', src: '공시', note: '사업보고서 주요 매출처 (합산 비중 10%대)' }, C(GROUPS.hyper, { src: '업계' }), { ...U('NVDA', 'NVIDIA'), src: '업계' }],
    segs: [{ name: 'DX(전자제품)' }, { name: 'DS(반도체)' }, { name: 'SDC(디스플레이)' }, { name: '하만(음향·전장)' }] },
  'KR:042700': { cust: [{ ...K('000660', 'SK하이닉스 (TC본더)'), src: '업계' }, { ...U('MU', 'Micron'), src: '업계' }, { name: 'OSAT(후공정 외주)', src: '업계' }], segs: [{ name: 'TC본더(HBM)' }, { name: '마이크로 쏘·비전 플레이스먼트' }] },
  'KR:131290': { cust: [C(GROUPS.mem3, { src: '업계', note: '프로브카드·인터페이스보드·테스트소켓 납품' })], segs: [{ name: '프로브카드·인터페이스보드·소켓(본사)' }, { ...K('252990', '샘씨엔에스 (세라믹 STF)'), note: '연결 자회사' }, { name: '메가터치 (포고핀)', note: '연결 자회사' }, { ...K('219130', '타이거일렉 (PCB)'), note: '연결 자회사' }] },
  'KR:252990': { cust: [{ name: '국내 낸드 프로브카드 업체', src: '업계' }, C(GROUPS.mem3, { name: '메모리 3사 (D램·HBM 프로브카드, 인증 진행)', src: '업계' })], segs: [{ name: '낸드용 세라믹 STF', note: '25년 3분기 누적 매출의 72%' }, { name: '디램용 세라믹 STF' }] },
  'KR:007660': { cust: [C(GROUPS.net, { src: '업계' }), { ...U('GOOGL', 'Google (TPU 보드)'), src: '업계' }, C(GROUPS.aisemi, { src: '업계' })], segs: [{ name: '고다층 MLB(네트워크·AI 가속기)' }] },
  'KR:403870': { cust: [{ ...K('005930', '삼성전자'), src: '업계' }, { ...U('TSM', 'TSMC'), src: '업계' }, { ...U('INTC', 'Intel'), src: '업계' }], segs: [{ name: '고압 수소 어닐링 장비' }, { name: '고압 산화 장비' }] },
  'KR:267260': { cust: [C(GROUPS.util, { name: '북미 전력회사', src: '업계' }), C(GROUPS.dc, { src: '업계' })], segs: [{ name: '변압기·차단기' }, { name: '회전기·배전' }] },
  'KR:298040': { cust: [C(GROUPS.util, { name: '북미·국내 전력회사', src: '업계' }), C(GROUPS.dc, { src: '업계' })], segs: [{ name: '중공업(변압기·차단기)' }, { name: '건설' }] },
};

/** 손익 흐름 재료 */
function plOf(m, rec) {
  if (!rec) return null;
  if (m === 'US') {
    const R = (rec.rows || []).slice(0, 4);
    if (R.length < 4) return null;
    const s = k => R.every(r => r[k] != null) ? R.reduce((a, r) => a + r[k], 0) : null;
    const rev = s('rev'), gp = s('gp'), rnd = s('rnd'), op = s('opInc'), net = s('net');
    if (!(rev > 0)) return null;
    return { unit: 'M$', period: `최근 4분기 (${R[R.length - 1].q}~${R[0].q})`, rev, cogs: gp != null ? rev - gp : null, gp, rnd, opx: gp != null && op != null ? gp - op - (rnd ?? 0) : null, op, net, other: op != null && net != null ? op - net : null };
  }
  const Y = (rec.kr?.yearly || []).filter(r => r.rev > 0);
  const act = [...Y].reverse().find(r => !r.est), est = Y.find(r => r.est);
  const one = r => r && { y: r.y, est: !!r.est, rev: r.rev, opx: r.op != null ? r.rev - r.op : null, op: r.op ?? null, net: r.np ?? null, other: r.op != null && r.np != null ? r.op - r.np : null };
  if (!act && !est) return null;
  return { unit: '억원', period: act ? `${act.y}년 실적` : `${est.y}년 추정`, ...one(act || est), next: act && est ? one(est) : null };
}

/** 흐름도 한 장 */
export async function buildFlow(m, code, { name, theme, rec, repoAt } = {}) {
  const key = `${m}:${code}`, ovr = await store.get(`flow:ovr:${m}:${code}`);
  const repo = !ovr && repoAt ? await repoFlow(m, code) : null;
  const base = ovr || repo || MAP[key] || null;
  let cust = base?.cust || [], src = ovr ? '직접 수정' : repo ? '조사' : base ? '정리표' : null;
  if (!cust.length && SECTOR_CUST[theme]?.length) { cust = SECTOR_CUST[theme].map(k => ({ ...GROUPS[k], src: '섹터 추정' })); src = '섹터 추정'; }
  return { v: FLOW_V, m, code, name, theme: theme || null, at: new Date().toISOString(), recAt: rec?.at || null, repoAt: repoAt || null, src,
    made: repo ? { at: repo.at || repoAt, by: repo.by || 'Claude 조사', summary: repo.summary || null, sources: (repo.sources || []).slice(0, 12) } : null,
    cust: cust.map(c => ({ name: c.name, code: c.code || null, m: c.m || null, share: c.share ?? null, src: c.conf || c.src || null, note: c.note || null, items: c.items || null, url: c.url || null })),
    segs: (base?.segs || []).map(s => ({ name: s.name, code: s.code || null, m: s.m || null, amt: s.amt ?? null, share: s.share ?? null, note: s.note || null, url: s.url || null })), unitSeg: base?.unitSeg || null,
    pl: plOf(m, rec) };
}

/** 저장된 것 쓰고, 7일 지났거나 재무 기록이 새로 들어왔으면 다시 만든다 */
export async function flowOf(m, code, ctx) {
  const K2 = `flow:${m}:${code}`, k = `${m}:${code}`;
  const [cur, idx, q] = await Promise.all([store.get(K2), repoIndex(), queue()]);
  const repoAt = idx[k]?.at || null;
  let f = cur;
  if (!(cur && cur.v === FLOW_V && cur.recAt === (ctx.rec?.at || null) && cur.theme === (ctx.theme || null) && cur.repoAt === repoAt && Date.now() - Date.parse(cur.at) < 7 * 864e5 && !ctx.force)) {
    f = await buildFlow(m, code, { ...ctx, repoAt });
    await store.set(K2, f, 30 * 86400);
  }
  // 예약 상태 — 예약 뒤에 조사 결과가 올라왔으면 예약을 지운다
  let job = q[k] || null;
  if (job && repoAt && repoAt >= job.at.slice(0, 10)) { await dequeue(k); job = null; }
  return { ...f, job };
}

/** 정기 작업이 읽는 예약 목록 — 한 줄에 하나: 시장|코드|이름|섹터|예약일|update|현재 조사일 */
export async function queueText() {
  const [q, idx] = await Promise.all([queue(), repoIndex()]);
  const rows = Object.values(q).sort((a, b) => (a.at < b.at ? -1 : 1));
  if (!rows.length) return 'EMPTY';
  return rows.map(x => [x.m, x.code, x.name, x.theme || '-', x.at.slice(0, 10), x.update ? 'update' : 'new', idx[`${x.m}:${x.code}`]?.at || '-'].join('|')).join('\n');
}

/** 관리자 수정 — {cust:[{name,code?,m?,share?,src?,note?}], segs:[{name,amt?,note?}]} 를 저장 (빈 값이면 지움) */
export async function saveFlowOvr(m, code, b) {
  const clean = arr => (Array.isArray(arr) ? arr : []).slice(0, 12).map(x => ({ name: String(x.name || '').slice(0, 60), code: x.code ? String(x.code).slice(0, 12) : null, m: x.m === 'KR' || x.m === 'US' ? x.m : null,
    share: Number.isFinite(+x.share) && x.share !== '' && x.share != null ? +x.share : null, amt: Number.isFinite(+x.amt) && x.amt !== '' && x.amt != null ? +x.amt : null,
    src: x.src ? String(x.src).slice(0, 20) : '직접', note: x.note ? String(x.note).slice(0, 120) : null })).filter(x => x.name);
  const o = { cust: clean(b.cust), segs: clean(b.segs) };
  if (!o.cust.length && !o.segs.length) await store.del(`flow:ovr:${m}:${code}`); else await store.set(`flow:ovr:${m}:${code}`, o);
  await store.del(`flow:${m}:${code}`);
  return o;
}
