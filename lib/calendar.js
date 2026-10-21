// 일정 캘린더 — 월간 매크로 지표·실적 발표·휴장일을 한 번에 받아 정리한다 (로그인·쿠키 없이 받는 공개 일정).
//   · 실적: 내 목록 종목이 발표했으면(숫자가 채워진 날) 재무·컨센서스를 다시 받고(op=earn) 밸류에이션 조사 대상으로 올린다 (scripts/intel/plan.py)
//   · 매크로: 발표된 지표의 전기 대비 변화와 앞으로 7일 일정을 화면·정기 조사에 준다
// 시각은 모두 한국시간. 미국 종목은 티커 없이 한글 이름만 오므로 lib/calalias.js 로 맞춘다 (국내는 6자리 코드가 그대로 온다).
import * as store from './store.js';
import { US_ALIAS } from './calalias.js';

const API = 'https://wts-cert-api.tossinvest.com/api/v4/calendar/monthly';
const HEAD = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9', Origin: 'https://www.tossinvest.com', Referer: 'https://www.tossinvest.com/calendar',
};
export const CAL_KEY = 'cal:data', EARN_KEY = 'earn:fresh';
const FRESH_MS = 3 * 3600e3;                                   // 일정은 하루 몇 번만 바뀐다 — 3시간 안에 받았으면 다시 받지 않는다
const WINDOW = 1, AHEAD = 7;                                    // '방금 발표' = 오늘·어제(KST), '곧' = 앞으로 7일

export const kst = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const nameKey = s => String(s || '').replace(/[\s.,()·&-]/g, '').toUpperCase();
const ALIAS = new Map(Object.entries(US_ALIAS).map(([k, v]) => [nameKey(k), v]));
const num = v => (v == null || Number.isNaN(+v) ? null : +v);
const pct = v => (v == null ? null : +(100 * v).toFixed(2));

/** 한 달치 원본 이벤트 */
export async function fetchMonth(ym, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${API}/${ym}`, { method: 'POST', headers: HEAD, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`캘린더 HTTP ${r.status}`);
      const events = (await r.json())?.result?.events;
      if (!Array.isArray(events)) throw new Error('캘린더 응답 형식이 달라졌어 (result.events 없음)');
      return events;
    } catch (e) { err = e; if (i < tries - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw err;
}

/* 지표 성격 — 전기 대비 변화를 '물가·고용·경기' 말로 읽어 준다 (예상치가 비어 있어 전기 대비만 본다) */
const KIND = [[/물가|CPI|PPI|PCE|임금/, 'infl'], [/실업|청구/, 'unemp'], [/고용|NFP|ADP/, 'jobs'], [/GDP|PMI|ISM|소매판매|심리|신뢰|제조업|주택|생산|수출|경기/, 'growth']];
const READ = { infl: ['물가 상승 — 금리 부담', '물가 둔화 — 금리 우호'], unemp: ['고용 둔화', '고용 개선'], jobs: ['고용 호조', '고용 둔화'], growth: ['경기 호조', '경기 둔화'] };
const MAJOR = /FOMC|금융통화위원회|CPI|PCE|NFP|실업률|GDP|ISM|소매판매|소비자물가|비농업|PPI/;
export function readOf(title, actual, prev) {
  if (actual == null || prev == null) return null;
  const d = actual - prev, kind = KIND.find(([re]) => re.test(title))?.[1];
  if (!kind) return null;
  if (Math.abs(d) < 1e-9) return '전기와 같음';
  return READ[kind][d > 0 ? 0 : 1];
}

/** 원본 이벤트 → { earnings, macro, holidays } */
export function normalize(events) {
  const earnings = [], macro = [], holidays = [];
  for (const e of events || []) {
    const g = e.id?.group, v = e.view || {}, se = e.stockEarnings;
    if (se && /EARNINGS/.test(g)) {
      const m = se.countryType === 'kr' ? 'KR' : 'US', hit = m === 'KR' ? String(se.companyCode) : ALIAS.get(nameKey(se.companyName)) || null;
      const reported = se.eps != null || se.sales != null || se.operatingProfit != null;
      earnings.push({
        m, code: hit, tossCode: se.companyCode, name: se.companyName, date: e.date, at: se.announceDateTime, when: se.announceMarketStatusText || null, reported,
        eps: num(se.eps), epsEst: num(se.epsEst), epsSurprise: pct(se.epsSurprise), sales: num(se.sales), salesEst: num(se.salesEst), salesSurprise: pct(se.salesSurprise),
        op: num(se.operatingProfit), opEst: num(se.operatingProfitEst), opSurprise: pct(se.operatingProfitSurprise),
        show: { eps: se.epsDisplay, epsEst: se.epsEstDisplay, sales: se.salesDisplay, salesEst: se.salesEstDisplay, op: se.operatingProfitDisplay, opEst: se.operatingProfitEstDisplay,
          epsSurprise: se.epsSurpriseDisplay, salesSurprise: se.salesSurpriseDisplay, opSurprise: se.operatingProfitSurpriseDisplay },
        call: v.upcomingLive?.liveAt || null,
      });
    } else if (g === 'ECONOMIC' && v.economicIndicatorValue) {
      const x = v.economicIndicatorValue, title = v.title || '', actual = num(x.actual), prev = num(x.historical);
      macro.push({
        id: e.id.uniqueName, date: e.date, time: (x.time || '').slice(0, 5), title, c: x.countryType === 'kr' ? 'KR' : 'US', actual, prev, forecast: num(x.forecast),
        unit: x.unitPrefix || '', basis: x.preAnnouncementWording || '', major: MAJOR.test(title), read: readOf(title, actual, prev),
        why: v.landingOption?.text || v.subtitle?.text || null,
      });
    } else if (g === 'HOLIDAY') holidays.push({ date: e.date, title: v.title, name: v.subtitle?.text || '' });
  }
  return { earnings, macro, holidays };
}

/** 이번 달 + (월초면 지난달, 월말이면 다음 달) 을 받아 저장한다. 3시간 안에 받았으면 저장본을 쓴다 (force 면 항상 새로) */
export async function loadCalendar({ force = false, now = Date.now() } = {}) {
  const cur = await store.get(CAL_KEY).catch(() => null);
  if (!force && cur?.at && now - Date.parse(cur.at) < FRESH_MS) return cur;
  const today = kst(now), months = [today.slice(0, 7)];
  if (+today.slice(8) <= WINDOW + 2) months.unshift(addDays(today, -4).slice(0, 7));
  if (addDays(today, AHEAD).slice(0, 7) !== today.slice(0, 7)) months.push(addDays(today, AHEAD).slice(0, 7));
  const uniq = [...new Set(months)], raw = [];
  let error = null;
  for (const ym of uniq) { try { raw.push(...await fetchMonth(ym)); } catch (e) { error = e.message; } }
  if (!raw.length) return cur ? { ...cur, error } : { at: null, earnings: [], macro: [], holidays: [], error };   // 다 실패하면 마지막 저장본
  const out = { at: new Date(now).toISOString(), months: uniq, ...normalize(raw), error };
  await store.set(CAL_KEY, out, 3 * 86400).catch(() => {});
  return out;
}

/** 내 목록(held = store.listAll() 결과) 기준으로 오늘 볼 것을 모은다 */
export function digest(cal, held, today = kst()) {
  const mine = new Set((held || []).map(x => `${x.m}:${x.code}`));
  const usHeld = (held || []).filter(x => x.m === 'US').map(x => x.code), known = new Set(Object.values(US_ALIAS));
  const earn = (cal.earnings || []).map(x => ({ ...x, mine: !!x.code && mine.has(`${x.m}:${x.code}`) }));
  const from = addDays(today, -WINDOW), to = addDays(today, AHEAD);
  const reported = earn.filter(x => x.reported && x.date >= from && x.date <= today).sort((a, b) => b.date.localeCompare(a.date) || (a.at || '').localeCompare(b.at || ''));
  const soon = earn.filter(x => !x.reported && x.date >= today && x.date <= to).sort((a, b) => (a.at || a.date).localeCompare(b.at || b.date));
  const macro = cal.macro || [];
  return {
    asof: today, at: cal.at, error: cal.error || null,
    earnings: { reported, soon, mineReported: reported.filter(x => x.mine), mineSoon: soon.filter(x => x.mine) },
    macro: {
      released: macro.filter(x => x.actual != null && x.date >= from && x.date <= today).sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time)),
      upcoming: macro.filter(x => x.actual == null && x.date >= today && x.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)),
    },
    holidays: (cal.holidays || []).filter(x => x.date >= today && x.date <= to),
    unmatched: [...new Set(earn.filter(x => x.m === 'US' && !x.code && x.date >= from && x.date <= to).map(x => x.name))],     // 한글 이름을 못 맞춘 미국 종목 — lib/calalias.js 에 추가
    aliasMissing: usHeld.filter(c => !known.has(c)),                                                                       // 내 목록 미국 종목 중 이름표가 없는 것 (이 종목은 실적 발표를 못 잡는다)
  };
}

/** 실적을 막 발표한 내 종목 → 재무·컨센서스를 발표 뒤에 한 번은 다시 받게 기록 { US: {MU: {d, after}}, KR: {...} }. after = 이 시각 뒤에 받은 재료만 발표 반영본 */
export async function markEarners(dg) {
  const rec = { at: new Date().toISOString(), d: dg.asof, US: {}, KR: {} };
  for (const x of dg.earnings.mineReported) {
    const after = new Date(Date.parse(`${(x.at || `${x.date}T00:00:00`).slice(0, 19)}+09:00`) + 3 * 3600e3).toISOString();     // 발표 3시간 뒤 (제공처 반영 시간)
    rec[x.m][x.code] = { d: x.date, after, name: x.name };
  }
  const prev = (await store.get(EARN_KEY).catch(() => null)) || {};
  for (const m of ['US', 'KR']) for (const [c, v] of Object.entries(prev[m] || {})) if (!rec[m][c] && v.d >= addDays(dg.asof, -3)) rec[m][c] = v;   // 3일은 유지 (제공처가 늦게 반영하는 경우)
  await store.set(EARN_KEY, rec, 4 * 86400).catch(() => {});
  return rec;
}
export const earnersOf = async m => (await store.get(EARN_KEY).catch(() => null))?.[m] || {};
