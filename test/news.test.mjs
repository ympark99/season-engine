// node --test test/news.test.mjs — 뉴스 조회 CLI (네트워크 없이 fetch 를 바꿔서)
import test from 'node:test';
import assert from 'node:assert/strict';
import { companyCode, news } from '../scripts/intel/news.mjs';

const real = globalThis.fetch;
const reply = body => async () => ({ ok: true, status: 200, json: async () => body });
test.afterEach(() => { globalThis.fetch = real; });

test('국내는 종목코드 그대로, 미국은 심볼이 정확히 같은 항목의 회사코드', async () => {
  assert.equal(await companyCode('KR', 'A000660'), '000660');
  globalThis.fetch = reply({ result: [{ type: 'PRODUCT', data: { items: [
    { symbol: 'SPCH', companyCode: 'EFAMXSPCH', autoComplete: true },
    { symbol: 'SPCX', companyCode: 'NAS0071BP-E0', autoComplete: true },
  ] } }] });
  assert.equal(await companyCode('US', 'spcx'), 'NAS0071BP-E0');
});

test('미국 종목이 검색에 없으면 오류', async () => {
  globalThis.fetch = reply({ result: [] });
  await assert.rejects(() => companyCode('US', 'ZZZZ'), /못 찾음/);
});

test('뉴스: 요약 공백 정리·관련 기사 수', async () => {
  globalThis.fetch = reply({ result: { body: [{ id: 'a', createdAt: '2026-10-21T10:00:00', title: ' 제목 ', summary: '가\n나  다', source: { name: '언론' }, relatedNews: [{}, {}] }] } });
  const [x] = await news('KR', '000660');
  assert.deepEqual([x.title, x.sum, x.also, x.src], ['제목', '가 나 다', 2, '언론']);
});
