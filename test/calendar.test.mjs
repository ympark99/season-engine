// node --test test/calendar.test.mjs — 일정 캘린더 정리·내 종목 매칭 (네트워크 없이 고정 입력으로)
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.STORE_FILE = path.join(os.tmpdir(), `cal-test-${process.pid}.json`);
const { normalize, digest, readOf, markEarners, earnersOf, addDays } = await import('../lib/calendar.js');

const earn = (group, se, date) => ({ id: { uniqueName: '', group }, view: { title: `${se.companyName} 실적발표` }, date, stockEarnings: { announceDateTime: `${date}T05:01:00`, ...se } });
const EV = [
  earn('USD_EARNINGS_ANNOUNCEMENT', { companyCode: 'NAS0077YX-E0', companyName: '메타', countryType: 'us', eps: 6.1, epsEst: 5.9, epsSurprise: 0.0339, epsSurpriseDisplay: '3.39%', epsDisplay: '6.10', epsEstDisplay: '5.90' }, '2026-10-22'),
  earn('USD_EARNINGS_ANNOUNCEMENT', { companyCode: 'NAS006XY7-E0', companyName: '테슬라', countryType: 'us' }, '2026-10-23'),
  earn('USD_EARNINGS_ANNOUNCEMENT', { companyCode: 'NYS000X-E0', companyName: '듣도보도못한회사', countryType: 'us' }, '2026-10-23'),
  earn('KRX_EARNINGS_ANNOUNCEMENT', { companyCode: '005930', companyName: '삼성전자', countryType: 'kr', operatingProfit: 1.07e14, operatingProfitEst: 1.06e14 }, '2026-10-21'),
  { id: { uniqueName: 'cpi', group: 'ECONOMIC' }, view: { title: '소비자물가지수(CPI) 발표(전년 대비)', economicIndicatorValue: { actual: 3.7, historical: 3.4, forecast: null, time: '21:30:00', countryType: 'us', unitPrefix: '%', preAnnouncementWording: '지난달' } }, date: '2026-10-22' },
  { id: { uniqueName: 'fomc', group: 'ECONOMIC' }, view: { title: 'FOMC 회의 결과 발표', economicIndicatorValue: { actual: null, historical: 4, time: '03:00:00', countryType: 'us', unitPrefix: '%' } }, date: '2026-10-29' },
  { id: { uniqueName: 'h', group: 'HOLIDAY' }, view: { title: '국내 휴장일', subtitle: { text: '개천절' } }, date: '2026-10-24' },
];
const HELD = [{ m: 'US', code: 'META' }, { m: 'US', code: 'TSLA' }, { m: 'US', code: 'ZZZZ' }, { m: 'KR', code: '005930' }];

test('실적: 국내는 종목코드, 미국은 한글 이름으로 티커를 맞춘다', () => {
  const { earnings } = normalize(EV);
  assert.deepEqual(earnings.map(x => x.code), ['META', 'TSLA', null, '005930']);
  assert.equal(earnings[0].reported, true);
  assert.equal(earnings[0].epsSurprise, 3.39);
  assert.equal(earnings[1].reported, false);                                  // 숫자가 비어 있으면 아직 발표 전
  assert.equal(earnings[3].reported, true);                                   // 국내는 영업이익만 있어도 발표
});

test('매크로: 전기 대비 해석', () => {
  assert.equal(readOf('소비자물가지수(CPI) 발표(전년 대비)', 3.7, 3.4), '물가 상승 — 금리 부담');
  assert.equal(readOf('실업률 발표', 4.0, 4.2), '고용 개선');
  assert.equal(readOf('FOMC 회의 결과 발표', 4, 4), null);                      // 해석 규칙이 없는 지표
  assert.equal(readOf('ISM 제조업 구매관리자지수 발표', null, 50), null);
});

test('요약: 방금 발표한 내 종목·곧 발표할 내 종목·이름표 점검', () => {
  const dg = digest(normalize(EV), HELD, '2026-10-22');
  assert.deepEqual(dg.earnings.mineReported.map(x => x.code), ['META', '005930']);   // 어제(10/21) 삼성전자도 포함
  assert.deepEqual(dg.earnings.mineSoon.map(x => x.code), ['TSLA']);
  assert.deepEqual(dg.unmatched, ['듣도보도못한회사']);
  assert.deepEqual(dg.aliasMissing, ['ZZZZ']);
  assert.deepEqual(dg.macro.released.map(x => x.id), ['cpi']);
  assert.deepEqual(dg.macro.upcoming.map(x => x.id), ['fomc']);
  assert.equal(dg.macro.upcoming[0].major, true);
  assert.equal(dg.holidays.length, 1);
});

test('발표 기록: 발표 3시간 뒤부터 다시 받기 대상, 3일 지나면 빠진다', async () => {
  const rec = await markEarners(digest(normalize(EV), HELD, '2026-10-22'));
  assert.equal(rec.US.META.after, new Date(Date.parse('2026-10-22T08:01:00+09:00')).toISOString());
  assert.deepEqual(Object.keys(await earnersOf('KR')), ['005930']);
  const later = await markEarners(digest(normalize([]), HELD, addDays('2026-10-22', 4)));
  assert.deepEqual(later.US, {});
});
