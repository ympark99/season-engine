// 옵션 신호 — 계절(봄 미확정·봄 확정·여름·가을·겨울)과 옵션 지표를 묶은 후보 규칙 + 자동 백테스트.
// 규칙은 검증(optbt:US)을 통과한 것만 화면에서 '신호'로 켜지고, 나머지는 '검증 중'으로 결과만 보여준다.
// 기록: optd:{날짜} = {code: 한 줄} — 매일 장 마감 뒤 lib/options.js snapshotAll 이 유니버스(S&P 500·나스닥 100·AI 밸류체인)+내 종목 미국을 저장
// 백테스트: 그날 계절은 저장된 일봉으로 다시 판정(analyzeV2 — 그날까지 데이터만 쓰는 판정), 이후 수익률도 일봉 종가로.
import * as store from './store.js';
import { analyzeV2 } from './engine2.js';
import { engineState, KEEP } from './service.js';

export const DKEY = d => `optd:${d}`, DAYS_KEY = 'optd:days', BT_KEY = 'optbt:US', D_TTL = 400 * 86400;
export const HZ = [1, 2, 5, 10];                                                  // 이후 거래일
export const PASS = { n: 100, dates: 15, edge: 0.5, t: 2, hit: 3 };               // 통과 기준 — 표본·날짜 수, 5일 초과수익 %p, 날짜 묶음 t, 상승 비율 차 %p

/** 압축 한 줄 (유니버스 저장용) */
export const rowOf = s => ({ px: s.px, fl: s.flip, gx: s.gex, cp: s.cpP, pv: s.pcV, cw: s.cw, cn: s.cwN, pw: s.pw, pn: s.pwN, oc: s.oi[0], op: s.oi[1], em: s.emPct, iv: s.iv30 });

/** 하루 특징 — cur·prev 는 압축 한 줄(rowOf 모양), avg = 그 전 20일 콜 프리미엄 비중 평균(5일 이상일 때) */
export function featOf(cur, prev, avg) {
  const F = {};
  if (cur.fl != null) { F.above = cur.px >= cur.fl; F.below = !F.above; }
  if (cur.gx != null) { F.gexP = cur.gx >= 0; F.gexN = cur.gx < 0; }
  if (cur.cp != null) {
    F.callSkew = avg != null ? cur.cp >= Math.max(60, avg + 10) : cur.cp >= 65;
    F.putSkew = avg != null ? cur.cp <= Math.min(40, avg - 10) : cur.cp <= 35;
  }
  if (prev) {
    if (prev.fl != null && cur.fl != null) { const pa = prev.px >= prev.fl; F.flipUp = !pa && F.above; F.flipDn = pa && F.below; }
    if (prev.gx != null && cur.gx != null) { F.gexPos = prev.gx < 0 && cur.gx >= 0; F.gexNeg = prev.gx >= 0 && cur.gx < 0; F.gexNegGrow = cur.gx < 0 && cur.gx < prev.gx; }
    if (prev.oc != null && cur.oc != null) { const dc = cur.oc - prev.oc, dp = cur.op - prev.op; F.callOIup = dc > 0 && dc > dp; F.putOIup = dp > 0 && dp > dc; }
    if (prev.cw != null && cur.cw != null) { F.cwUp = cur.cw > prev.cw; F.cwDn = cur.cw < prev.cw; }
  }
  for (const k of Object.keys(F)) if (!F[k]) delete F[k];
  return F;
}

/** 계절 상태 — SU 봄 미확정 · SC 봄 확정 · U 여름 · A 가을 · W 겨울 */
export const ST_NAME = { SU: '봄 미확정', SC: '봄 확정', U: '여름', A: '가을', W: '겨울' };
const ALL = ['SU', 'SC', 'U', 'A', 'W'];

/** 후보 규칙 — when = OR(AND(특징…)) · dir up(오를 것)/down(빠질 것) · use = 맞으면 어떻게 쓸지 */
export const RULES = [
  { id: 'SU1', st: ['SU'], dir: 'up', name: '봄 선진입', when: [['above', 'callSkew'], ['flipUp', 'callSkew']], use: '봄 미확정이지만 옵션 수급이 우호적 — 확정 전 소량 선진입 후보' },
  { id: 'SP1', st: ['SU', 'SC'], dir: 'down', name: '봄 실패 경고', when: [['flipDn'], ['below', 'putSkew']], use: '봄 반등이 꺾일 위험 — 신규 진입 보류·봄 비중 축소' },
  { id: 'SC1', st: ['SC'], dir: 'up', name: '봄 확정 강화', when: [['above', 'gexP'], ['above', 'callOIup']], use: '확정 봄 + 감마 안정 — 비중 확대(여름 전 선매수)' },
  { id: 'U1', st: ['U'], dir: 'up', name: '여름 추가매수', when: [['above', 'callSkew', 'callOIup'], ['flipUp', 'callSkew']], use: '여름 모멘텀에 콜 자금·새 포지션까지 — 추가매수·단기진입 신뢰도 ↑' },
  { id: 'U2', st: ['U'], dir: 'down', name: '여름 경고', when: [['flipDn'], ['below', 'putSkew']], use: '여름 중 감마 지지 이탈·풋 쏠림 — 익절·TS 강화' },
  { id: 'A1', st: ['A'], dir: 'up', name: '가을 재가속', when: [['flipUp'], ['above', 'callSkew']], use: '가을이지만 옵션은 다시 위 — 50% 정리 보류' },
  { id: 'A2', st: ['A'], dir: 'down', name: '가을 매도 가속', when: [['below', 'gexN']], use: '가을 + 감마 음수 구간 — 남은 비중 정리 앞당김' },
  { id: 'W1', st: ['W'], dir: 'down', name: '겨울 하락 지속', when: [['below', 'gexNegGrow'], ['below', 'putOIup']], use: '겨울 + 음의 감마 확대 — 저점매수 보류' },
  { id: 'W2', st: ['W'], dir: 'up', name: '겨울 반등', when: [['flipUp'], ['callSkew', 'callOIup']], use: '겨울 중 옵션 수급 반전 — 저점매수 신뢰도 ↑' },
  { id: 'E1', st: ALL, dir: 'up', name: '플립 회복', when: [['flipUp']], use: '계절 무관 사건' },
  { id: 'E2', st: ALL, dir: 'down', name: '플립 이탈', when: [['flipDn']], use: '계절 무관 사건' },
  { id: 'E3', st: ALL, dir: 'up', name: 'GEX 양전', when: [['gexPos']], use: '계절 무관 사건' },
  { id: 'E4', st: ALL, dir: 'down', name: 'GEX 음전', when: [['gexNeg']], use: '계절 무관 사건' },
  { id: 'E5', st: ALL, dir: 'up', name: '콜 월 상향', when: [['cwUp']], use: '계절 무관 사건' },
  { id: 'E6', st: ALL, dir: 'down', name: '콜 월 하향', when: [['cwDn']], use: '계절 무관 사건' },
];
export const FEAT_NAME = { above: '플립 위', below: '플립 아래', gexP: 'GEX ≥ 0', gexN: 'GEX < 0', callSkew: '콜 쏠림', putSkew: '풋 쏠림', flipUp: '플립 회복', flipDn: '플립 이탈',
  gexPos: 'GEX 양전', gexNeg: 'GEX 음전', gexNegGrow: '음의 GEX 확대', callOIup: '콜 미결제약정 증가', putOIup: '풋 미결제약정 증가', cwUp: '콜 월 상향', cwDn: '콜 월 하향' };
export const hit = (rule, st, F) => rule.st.includes(st) && rule.when.some(g => g.every(k => F[k]));

/** 하루 기록 저장 (같은 날짜 키에 합침) */
export async function saveDay(d, rows) {
  if (!d || !Object.keys(rows).length) return;
  const cur = (await store.get(DKEY(d))) || {};
  await store.set(DKEY(d), { ...cur, ...rows }, D_TTL);
  const days = (await store.get(DAYS_KEY)) || [];
  if (!days.includes(d)) await store.set(DAYS_KEY, [...days, d].sort().slice(-300));
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));

/** 백테스트 — 저장된 날짜별 기록 + 일봉. 결과는 optbt:US */
export async function runBacktest({ budgetMs = 250000 } = {}) {
  const t0 = Date.now(), days = ((await store.get(DAYS_KEY)) || []).sort();
  const byCode = new Map();                                                        // code → [{d, ...row}]
  for (let i = 0; i < days.length; i += 20) {
    const part = days.slice(i, i + 20), recs = await store.mget(part.map(DKEY));
    part.forEach((d, k) => { for (const [c, r] of Object.entries(recs[k] || {})) { if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push({ d, ...r }); } });
  }
  const eng = await engineState(), codes = [...byCode.keys()];
  const S = {};                                                                    // 규칙별 표본
  const base = {};                                                                 // 계절 상태별 기준 (같은 상태 전체)
  const add = (o, k, h, v) => { const x = o[k] || (o[k] = { r: {}, dd: [], dates: {} }); (x.r[h] || (x.r[h] = [])).push(v); };
  let nRows = 0, nCodes = 0;
  for (let i = 0; i < codes.length; i += 25) {
    if (Date.now() - t0 > budgetMs) break;
    const part = codes.slice(i, i + 25), bars = await store.mget(part.map(c => store.barsKey('US', c)));
    part.forEach((c, k) => {
      const B = bars[k]; if (!B?.d?.length || B.d.length < 200) return;
      let A; try { A = analyzeV2(B, eng.params, eng.cal, KEEP); } catch { return; }
      const ser = A.series, at = new Map(ser.d.map((d, j) => [d, j])), C = ser.c;
      const R = byCode.get(c).sort((a, b) => (a.d < b.d ? -1 : 1));
      nCodes++;
      for (let j = 0; j < R.length; j++) {
        const cur = R[j], t = at.get(cur.d); if (t == null) continue;
        const sn = +ser.s[t], st = sn === 0 ? (ser.f?.[t] === '1' ? 'SC' : 'SU') : ['', 'U', 'A', 'W'][sn];
        const prev = j > 0 && Date.parse(cur.d) - Date.parse(R[j - 1].d) <= 5 * 864e5 ? R[j - 1] : null;
        const hist = R.slice(Math.max(0, j - 20), j).map(x => x.cp).filter(v => v != null);
        const F = featOf(cur, prev, hist.length >= 5 ? mean(hist) : null);
        const fw = {}; for (const h of HZ) if (t + h < C.length) fw[h] = (C[t + h] / C[t] - 1) * 100;
        let dd = null; if (t + 10 < C.length) { let m = Infinity; for (let q = t + 1; q <= t + 10; q++) m = Math.min(m, C[q]); dd = (m / C[t] - 1) * 100; }
        nRows++;
        for (const h of HZ) if (fw[h] != null) add(base, st, h, fw[h]);
        if (dd != null) (base[st] ||= { r: {}, dd: [], dates: {} }).dd.push(dd);
        for (const rule of RULES) if (hit(rule, st, F)) {
          const x = S[rule.id] || (S[rule.id] = { hits: [] });
          x.hits.push({ d: cur.d, st, fw, dd });
        }
      }
    });
  }
  const bm = {}; for (const [st, o] of Object.entries(base)) { bm[st] = {}; for (const h of HZ) bm[st][h] = { m: mean(o.r[h] || []), up: o.r[h]?.length ? 100 * o.r[h].filter(v => v > 0).length / o.r[h].length : null, n: o.r[h]?.length || 0 }; bm[st].dd = mean(o.dd); }
  const rules = RULES.map(rule => {
    const hs = S[rule.id]?.hits || [], out = { id: rule.id, name: rule.name, st: rule.st, dir: rule.dir, use: rule.use, when: rule.when, n: hs.length, dates: new Set(hs.map(h => h.d)).size, h: {} };
    const sg = rule.dir === 'up' ? 1 : -1;
    for (const h of HZ) {
      const xs = hs.filter(x => x.fw[h] != null);
      if (!xs.length) { out.h[h] = null; continue; }
      const ex = xs.map(x => x.fw[h] - (bm[x.st]?.[h]?.m ?? 0));                      // 같은 계절 상태 평균 대비 초과
      const byD = {}; xs.forEach((x, k) => { (byD[x.d] ||= []).push(ex[k]); });
      const dm = Object.values(byD).map(mean), mu = mean(dm), sd = dm.length > 1 ? Math.sqrt(dm.reduce((a, v) => a + (v - mu) ** 2, 0) / (dm.length - 1)) : null;
      const up = 100 * xs.filter(x => x.fw[h] > 0).length / xs.length, upB = mean(xs.map(x => bm[x.st]?.[h]?.up ?? 50));
      out.h[h] = { n: xs.length, avg: r2(mean(xs.map(x => x.fw[h]))), base: r2(mean(xs.map(x => bm[x.st]?.[h]?.m ?? 0))), edge: r2(mu), t: sd ? r2(mu / (sd / Math.sqrt(dm.length))) : null, up: r2(up), upBase: r2(upB) };
    }
    const dd = hs.map(x => x.dd).filter(v => v != null);
    out.dd10 = r2(mean(dd)); out.dd10Base = r2(mean(hs.filter(x => x.dd != null).map(x => bm[x.st]?.dd ?? 0)));
    const h5 = out.h[5];
    out.status = !h5 || out.n < PASS.n || out.dates < PASS.dates ? 'wait'
      : sg * h5.edge >= PASS.edge && sg * (h5.t ?? 0) >= PASS.t && sg * (h5.up - h5.upBase) >= PASS.hit ? 'pass' : 'fail';
    return out;
  });
  const res = { at: new Date().toISOString(), days: days.length, from: days[0] || null, to: days[days.length - 1] || null, codes: nCodes, rows: nRows, pass: PASS, base: bm, rules, ms: Date.now() - t0 };
  await store.set(BT_KEY, res);
  return res;
}

/** 화면용 — 규칙 정의 + 최신 검증 상태 (상세·목록이 오늘 특징과 맞춰 본다) */
export async function rulesView() {
  const bt = await store.get(BT_KEY).catch(() => null), by = new Map((bt?.rules || []).map(r => [r.id, r]));
  return { at: bt?.at || null, days: bt?.days || 0, pass: PASS,
    rules: RULES.map(r => { const b = by.get(r.id); return { id: r.id, name: r.name, st: r.st, dir: r.dir, use: r.use, when: r.when, status: b?.status || 'wait', n: b?.n || 0, dates: b?.dates || 0, h5: b?.h?.[5] || null }; }) };
}
