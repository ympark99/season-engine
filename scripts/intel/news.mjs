#!/usr/bin/env node
// 종목 뉴스 조회 — WebSearch 대신 먼저 쓰는 가벼운 뉴스 목록 (제목·날짜·언론사·요약 앞부분만, 본문 제외).
// 사용: node scripts/intel/news.mjs [옵션] US:SPCX KR:000660 ...
//   --days N     최근 N일만 (기본 3)
//   --n N        종목당 최대 N건 (기본 8)
//   --sum N      요약 앞 N자 (기본 120, 0 이면 제목만)
//   --json       JSON 으로 출력 (기본은 한 줄씩 텍스트)
//   --order X    relevant(기본) | latest
// 주소: 국내는 종목코드 6자리가 그대로 회사코드, 미국은 티커 → 검색 API 로 회사코드(예: SPCX → NAS0071BP-E0)를 찾는다. 로그인·쿠키 불필요.
// 뉴스에는 원문 URL 이 없다. 사이트에 출처로 남길 소식은 제목으로 WebSearch 해서 URL 을 확인한다.
// 실패한 종목은 'FAIL' 줄로 알리고 종료코드는 0 — 부른 쪽은 그 종목만 WebSearch 로 대신한다.
const NEWS = 'https://wts-info-api.tossinvest.com/api/v2/news/companies';
const FIND = 'https://wts-info-api.tossinvest.com/api/v3/search-all/wts-auto-complete';
const HEAD = {
  Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9', Origin: 'https://www.tossinvest.com', Referer: 'https://www.tossinvest.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
};

async function call(url, init = {}, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...HEAD, ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      err = new Error(`HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { err = e; }
    await new Promise(s => setTimeout(s, 800 * (i + 1)));
  }
  throw err;
}

/** 티커 → 토스 회사코드. 심볼이 정확히 같은 항목만 (SPCX 검색에 섞여 나오는 SPCH 같은 파생 ETF 는 거른다). 같은 심볼이 여럿이면 자동완성에 잡힌 것을 먼저. */
export async function companyCode(m, code) {
  if (m === 'KR') return code.replace(/^A/, '');
  const j = await call(FIND, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: code, sections: [{ type: 'PRODUCT' }] }) });
  const items = (j.result || []).find(x => x.type === 'PRODUCT')?.data?.items || [];
  const hit = items.filter(i => String(i.symbol).toUpperCase() === code.toUpperCase());
  const pick = hit.find(i => i.autoComplete) || hit[0];
  if (!pick) throw new Error(`종목 못 찾음: ${code}`);
  return pick.companyCode;
}

export async function news(m, code, { n = 8, order = 'relevant' } = {}) {
  const cc = await companyCode(m, code);
  const j = await call(`${NEWS}/${encodeURIComponent(cc)}?size=${Math.min(Math.max(n * 3, 20), 50)}&orderBy=${order}`);
  return (j.result?.body || []).map(x => ({
    id: x.id, at: x.createdAt, src: x.source?.name || x.source?.code || '', title: (x.title || '').trim(),
    sum: (x.summary || x.contentText || '').replace(/\s+/g, ' ').trim(),
    also: (x.relatedNews || []).length,                      // 같은 소식을 다룬 다른 기사 수 — 클수록 큰 소식
  }));
}

function parse(argv) {
  const o = { days: 3, n: 8, sum: 120, json: false, order: 'relevant', targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (['--days', '--n', '--sum'].includes(a)) o[a.slice(2)] = Number(argv[++i]);
    else if (a === '--order') o.order = argv[++i];
    else {
      const [m, code] = a.split(':');
      if (!['US', 'KR'].includes(m) || !code) throw new Error(`대상 형식: US:TSLA 또는 KR:005930 (받은 값: ${a})`);
      o.targets.push({ m, code });
    }
  }
  if (!o.targets.length) throw new Error('대상이 없다. 예: node scripts/intel/news.mjs US:SPCX KR:000660');
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const since = new Date(Date.now() + 9 * 3600e3 - o.days * 86400e3).toISOString().slice(0, 19);   // createdAt 은 KST 문자열
  const out = [];
  for (const t of o.targets) {
    try {
      const rows = (await news(t.m, t.code, o)).filter(x => x.at >= since).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, o.n);
      out.push({ ...t, items: rows });
    } catch (e) {
      out.push({ ...t, error: e.message });
    }
  }
  if (o.json) { console.log(JSON.stringify(out)); return; }
  for (const r of out) {
    if (r.error) { console.log(`## ${r.m}:${r.code} FAIL ${r.error}`); continue; }
    console.log(`## ${r.m}:${r.code} 최근 ${o.days}일 ${r.items.length}건`);
    for (const x of r.items) {
      const s = o.sum && x.sum ? ` — ${x.sum.slice(0, o.sum)}${x.sum.length > o.sum ? '…' : ''}` : '';
      console.log(`${x.at.slice(0, 16).replace('T', ' ')} [${x.src}]${x.also ? `(+${x.also})` : ''} ${x.title}${s}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(2); });
