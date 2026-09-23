// KIS 종목 마스터 내려받기·파싱 — 지수 구성종목(S&P500·나스닥100·코스피200·코스닥150) 추출용.
// 국내 .mst 는 [단축코드9][표준코드12][한글명…][고정폭 tail]. tail 안의 위치는 KIS 공개 정제코드(kis_kospi_code_mst.py)의 field_specs 누적값.
//   코스피 tail 227: +0 그룹코드(2), +18 KOSPI200 섹터업종(0=미편입), +19 KOSPI100
//   코스닥 tail 221: +0 증권그룹(2), +35 KOSDAQ150 여부(Y/N)
// 해외 frgn_code.mst 는 행 끝 14자리 = [업종코드4][다우30 1][나스닥100 1][S&P500 1][거래솄4][국가3], 심볼은 row[1:11].
import zlib from 'node:zlib';

const BASE = process.env.MASTER_BASE || 'https://new.real.download.dws.co.kr/common/master/';
const dec = new TextDecoder('euc-kr');

export function unzipFirst(buf) {               // 단일 파일 zip: 중앙 디렉터리에서 크기·위치를 읽고 inflateRaw
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

export async function getMaster(name, ms = 30000) {
  const r = await fetch(BASE + name, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  return dec.decode(unzipFirst(Buffer.from(await r.arrayBuffer())));
}

/** 국내 마스터: tail 길이를 후보 중에서 자동 판별 (ST 종목이 가장 많이 잡히는 값) */
function krRows(text, tail) {
  const out = [];
  for (const row of text.split(/\r?\n/)) {
    if (row.length <= tail + 21) continue;
    const head = row.slice(0, row.length - tail), t = row.slice(row.length - tail);
    const code = head.slice(0, 9).trim(), name = head.slice(21).trim();
    if (t.slice(0, 2) !== 'ST' || !/^[0-9A-Z]{6}$/.test(code)) continue;
    out.push({ code, name, t });
  }
  return out;
}
function krBest(text, tail) {
  return [tail - 1, tail, tail - 2, tail + 1].map(t => ({ t, rows: krRows(text, t) })).sort((a, b) => b.rows.length - a.rows.length)[0];
}

/** 코스피200 구성종목 [{m:'KR',code,name}] */
export function parseKospi200(text) {
  const { rows } = krBest(text, 228);
  return rows.filter(r => /[1-9]/.test(r.t.slice(18, 19))).map(r => ({ m: 'KR', code: r.code, name: r.name }));
}
/** 코스닥150 구성종목 */
export function parseKosdaq150(text) {
  const { rows } = krBest(text, 222);
  return rows.filter(r => r.t.slice(35, 36) === 'Y').map(r => ({ m: 'KR', code: r.code, name: r.name }));
}

const EXCD = { NAS: 'NAS', NYS: 'NYS', AMS: 'AMS', NASD: 'NAS', NYSE: 'NYS', AMEX: 'AMS' };
/** 해외 지수 마스터에서 S&P500 / 나스닥100 구성종목. idx = 'spx' | 'ndx' */
export function parseFrgn(text, idx) {
  const at = idx === 'ndx' ? 5 : 6;                       // 업종4 + 다우1(4) + 나스닥100(5) + S&P500(6)
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const row = line.replace(/[\r\n]+$/, '');   // 공백은 자르면 안 됨 — 끝 14자리가 고정폭 필드
    if (row.length < 40) continue;
    const tail = row.slice(-14);
    if (tail[at] !== '1') continue;
    const code = row.slice(1, 11).trim(), name = row.slice(11, 50).replace(/,/g, '').trim();
    if (!/^[A-Z][A-Z.\-]{0,9}$/.test(code)) continue;
    out.push({ m: 'US', code, name, excd: EXCD[tail.slice(7, 11).trim().toUpperCase()] || null });
  }
  return out;
}

/** 네 지수 구성종목을 한 번에. 실패한 지수는 errors 에 남기고 나머지는 계속 */
export async function fetchUniverse() {
  const errors = [], sets = {};
  const jobs = [
    ['SPX', 'frgn_code.mst.zip', t => parseFrgn(t, 'spx'), [400, 600]],
    ['NDX', 'frgn_code.mst.zip', t => parseFrgn(t, 'ndx'), [80, 130]],
    ['K200', 'kospi_code.mst.zip', parseKospi200, [150, 230]],
    ['KQ150', 'kosdaq_code.mst.zip', parseKosdaq150, [100, 200]],
  ];
  const cache = {};
  for (const [key, file, fn, [lo, hi]] of jobs) {
    try {
      cache[file] = cache[file] || await getMaster(file);
      const rows = fn(cache[file]);
      if (!rows.length) throw new Error('0종목 — 마스터 형식이 바뀜 듯');
      sets[key] = rows;
      if (rows.length < lo || rows.length > hi) errors.push(`${key} ${rows.length}종목 — 예상(${lo}~${hi}) 밖이라 확인 필요`);
    } catch (e) { errors.push(`${key}: ${e.message.slice(0, 120)}`); }
  }
  return { sets, errors, at: new Date().toISOString() };
}
