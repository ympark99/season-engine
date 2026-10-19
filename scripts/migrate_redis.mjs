// Redis → Redis 이전 (Upstash REST 호환 양쪽). 값·만료를 그대로 복사한다.
// 사용: SRC_URL=.. SRC_TOKEN=.. DST_URL=.. DST_TOKEN=.. node scripts/migrate_redis.mjs [--dry]
const { SRC_URL, SRC_TOKEN, DST_URL, DST_TOKEN } = process.env, dry = process.argv.includes('--dry');
if (!SRC_URL || !SRC_TOKEN || (!dry && (!DST_URL || !DST_TOKEN))) { console.error('SRC_URL SRC_TOKEN DST_URL DST_TOKEN 환경변수가 필요해'); process.exit(1); }
const post = async (url, token, path, body) => {
  const r = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok || j.error) throw new Error(`${path} ${r.status} ${j.error || ''}`); return j;
};
const src = c => post(SRC_URL, SRC_TOKEN, '', c).then(j => j.result);
const srcPipe = cs => post(SRC_URL, SRC_TOKEN, '/pipeline', cs).then(rs => rs.map(x => { if (x.error) throw new Error(x.error); return x.result; }));
const dstPipe = cs => post(DST_URL, DST_TOKEN, '/pipeline', cs).then(rs => rs.forEach(x => { if (x.error) throw new Error(x.error); }));

let cursor = '0', keys = [];
do { const [c, ks] = await src(['SCAN', cursor, 'COUNT', 500]); cursor = String(c); keys.push(...ks); } while (cursor !== '0');
keys = [...new Set(keys)];
console.log(`키 ${keys.length}개`);
let n = 0, bytes = 0; const skipped = [];
for (let i = 0; i < keys.length; i += 20) {
  const part = keys.slice(i, i + 20);
  const types = await srcPipe(part.map(k => ['TYPE', k]));
  const ttls = await srcPipe(part.map(k => ['PTTL', k]));
  const vals = await srcPipe(part.map((k, j) => (types[j] === 'string' ? ['GET', k] : types[j] === 'hash' ? ['HGETALL', k] : ['TYPE', k])));
  const out = [];
  part.forEach((k, j) => {
    const t = types[j], v = vals[j], ttl = ttls[j];
    if (t === 'string') { out.push(ttl > 0 ? ['SET', k, v, 'PX', ttl] : ['SET', k, v]); bytes += v.length; }
    else if (t === 'hash' && v.length) { out.push(['DEL', k], ['HSET', k, ...v]); if (ttl > 0) out.push(['PEXPIRE', k, ttl]); bytes += v.reduce((s, x) => s + x.length, 0); }
    else skipped.push(`${k}(${t})`);
  });
  if (!dry && out.length) await dstPipe(out);
  n += part.length;
  if ((i / 20) % 10 === 0) console.log(`${n}/${keys.length}`);
}
console.log(`${dry ? '[dry] ' : ''}복사 ${n - skipped.length}개 · 약 ${(bytes / 1e6).toFixed(1)}MB · 건너뜀 ${skipped.length}${skipped.length ? ' → ' + skipped.slice(0, 10).join(', ') : ''}`);
if (!dry) {
  const [a, b] = await Promise.all([src(['DBSIZE']), post(DST_URL, DST_TOKEN, '', ['DBSIZE']).then(j => j.result)]);
  console.log(`키 수 확인: 원본 ${a} · 새 DB ${b}`);
}
