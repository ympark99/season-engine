// 빌드 때 KIS 종목 마스터(코스피·코스닥·나스닥·뉴욕·아멕스)를 받아 검색용 public/data/master.json 생성.
// 실패하면 lib/fallback_master.js(95종목)로 대체 — 배포는 절대 막지 않음.
import fs from 'node:fs';
import zlib from 'node:zlib';
import fallback from '../lib/fallback_master.js';

const BASE = process.env.MASTER_BASE || 'https://new.real.download.dws.co.kr/common/master/';
const OUT = new URL('../public/data/master.json', import.meta.url);
const dec = new TextDecoder('euc-kr');

function unzipFirst(buf) {               // 단일 파일 zip: 중앙 디렉터리에서 크기·위치 읽고 inflateRaw
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}
async function get(name) {
  const r = await fetch(BASE + name, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  return dec.decode(unzipFirst(Buffer.from(await r.arrayBuffer())));
}

// 국내 .mst: 행 = [단축코드 9][표준코드 12][한글명 …][고정폭 영역 228(코스피)/222(코스닥)], 고정폭 앞 2자리 = 그룹코드(ST=주권)
function parseKR(text, tail) {
  const out = [];
  for (const row of text.split(/\r?\n/)) {
    if (row.length <= tail + 21) continue;
    const head = row.slice(0, row.length - tail), grp = row.slice(row.length - tail, row.length - tail + 2);
    const code = head.slice(0, 9).trim(), name = head.slice(21).trim();
    if (grp === 'ST' && /^[0-9A-Z]{6}$/.test(code)) out.push(['KR', code, name, null]);
  }
  return out;
}
// 해외 .cod: 탭 구분 — [4]심볼 [6]한글명 [7]영문명 [8]종류(2=주식, 3=ETF)
function parseUS(text, excd) {
  const out = [];
  for (const row of text.split(/\r?\n/)) {
    const f = row.split('\t');
    if (f.length < 9 || !['2', '3'].includes(f[8].trim())) continue;
    const sym = f[4].trim(), ko = f[6].trim(), en = f[7].trim();
    if (/^[A-Z][A-Z.\-]{0,9}$/.test(sym)) out.push(['US', sym, en || ko, excd, ko]);
  }
  return out;
}

const all = [], log = [];
for (const [file, fn] of [['kospi_code.mst.zip', t => parseKR(t, 228)], ['kosdaq_code.mst.zip', t => parseKR(t, 222)],
  ['nasmst.cod.zip', t => parseUS(t, 'NAS')], ['nysmst.cod.zip', t => parseUS(t, 'NYS')], ['amsmst.cod.zip', t => parseUS(t, 'AMS')]]) {
  try { const rows = fn(await get(file)); all.push(...rows); log.push(`${file} ${rows.length}`); }
  catch (e) { log.push(`${file} 실패: ${e.message}`); }
}
fs.mkdirSync(new URL('../public/data/', import.meta.url), { recursive: true });
const seen = new Set();
const uniq = all.filter(x => { const k = x[0] + ':' + x[1]; if (seen.has(k)) return false; seen.add(k); return true; });
all.length = 0; all.push(...uniq);
const kr = all.filter(x => x[0] === 'KR').length, us = all.length - kr;
if (kr < 1000 || us < 1000) {
  fs.writeFileSync(OUT, JSON.stringify({ source: 'fallback', at: new Date().toISOString(), rows: fallback.map(x => [x.m, x.code, x.name, x.excd || null]) }));
  console.log(`[master] 대체 목록 사용 (${fallback.length}) — ${log.join(' · ')}`);
} else {
  fs.writeFileSync(OUT, JSON.stringify({ source: 'KIS master', at: new Date().toISOString(), rows: all }));
  console.log(`[master] 한국 ${kr} · 미국 ${us} — ${log.join(' · ')}`);
}
