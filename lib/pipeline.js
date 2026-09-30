// 매일 자동 갱신 파이프라인 — 시장별로 아래 단계를 순서대로, 한 번 호출에 한 조각씩 진행한다.
//   list  내 목록 + 시장 지수 새 봉
//   scan  유니버스 전종목 새 봉·판정
//   bt    국면 신뢰도 측정 → 임계값 보정 (하루 4판)
//   fund  펀더멘털 수집 (7일 지난 종목만, 한 바퀴 끝나면 점수화)
//   pf    예시 포트폴리오
// 한 조각이 끝나면 다음 조각을 스스로 부르고(kick), 그게 끊겨도 vercel.json 의 예비 크론들이 같은 자리에서 이어받는다.
// 동시에 두 개가 돌지 않도록 시장별 잠금을 건다.
import * as store from './store.js';
import { refresh } from './service.js';
import { INDICES, refreshIndex } from './market.js';
import { scanBatch, kstDate } from './universe.js';
import { kick } from './selfcall.js';
import { autoStep as btStep } from '../api/backtest.js';
import { collectChunk } from '../api/fundamentals.js';
import { run as runPf } from '../api/portfolio.js';

export const STAGES = ['list', 'scan', 'bt', 'fund', 'pf', 'done'];
const KEY = m => `pipe:${m}`, LOCK = m => `pipe:lock:${m}`;
const LOCK_S = 58;

async function stageList(m) {
  const t0 = Date.now(), items = (await store.listAll()).filter(x => x.m === m);
  const ok = [], failed = [];
  for (const ix of INDICES.filter(x => x.grp === m)) {
    try { const r = await refreshIndex(ix); ok.push(`${ix.code}+${r.added}`); } catch (e) { failed.push({ code: ix.code, error: e.message.slice(0, 160) }); }
  }
  for (const it of items) {
    if (Date.now() - t0 > 45_000) break;
    try { const r = await refresh(it); ok.push(`${it.code}+${r.added}`); if (r.excd && r.excd !== it.excd) await store.listPut({ ...it, excd: r.excd }); }
    catch (e) { failed.push({ code: it.code, error: e.message.slice(0, 160) }); }
  }
  await store.set(`cron:${m}`, { at: new Date().toISOString(), m, ok: ok.length, failed, ms: Date.now() - t0 });
  return { next: true, note: `목록·지수 ${ok.length}건 갱신${failed.length ? `, 실패 ${failed.length}` : ''}` };
}

async function runStage(stage, m) {
  if (stage === 'list') return stageList(m);
  if (stage === 'scan') { const r = await scanBatch(m, { budgetMs: 42000 }); return { next: r.done, note: `스캔 ${r.i}/${r.total}` }; }
  if (stage === 'bt') { const r = await btStep(m); return { next: !r.more, note: r.did ? (r.did.kind === 'run' ? `신뢰도 ${r.did.r.phase} ${r.did.r.i}/${r.did.r.total}` : `보정 ${r.did.todayRounds}/4판`) : '신뢰도·보정 끝' }; }
  if (stage === 'fund') { const r = await collectChunk(m); return { next: r.done, note: r.idle ? '펀더멘털 최신 (이번 주기 완료)' : `펀더멘털 ${r.i}/${r.total}${r.blocked ? ' — 막힘' : ''}` }; }
  if (stage === 'pf') { await runPf(m); return { next: true, note: '예시 포트폴리오 갱신' }; }
  return { next: false, note: '오늘 할 일 끝' };
}

/** 한 조각 실행. 잠겨 있으면 그냥 돌아감 (다른 호출이 진행 중) */
export async function step(m, { from = 'cron' } = {}) {
  const got = await store.setNX(LOCK(m), { at: new Date().toISOString(), from }, LOCK_S);
  if (got !== 'OK') return { m, busy: true };
  const today = kstDate();
  let p = await store.get(KEY(m));
  if (!p || p.date !== today) p = { date: today, stage: 'list', startedAt: new Date().toISOString(), log: [], errors: 0 };
  const stage = p.stage;
  let res;
  try {
    res = await runStage(stage, m);
    p.errors = 0;
    if (res.next) p.stage = STAGES[STAGES.indexOf(stage) + 1] || 'done';
  } catch (e) {
    res = { next: false, note: `오류: ${e.message.slice(0, 160)}` };
    p.errors = (p.errors || 0) + 1;
    if (p.errors >= 3) { p.stage = STAGES[STAGES.indexOf(stage) + 1] || 'done'; res.note += ' — 3번 연속 실패로 이 단계는 건너뜀'; p.errors = 0; }
  }
  p.log = [{ at: new Date().toISOString(), stage, from, note: res.note }, ...(p.log || [])].slice(0, 30);
  p.updatedAt = new Date().toISOString();
  if (p.stage === 'done' && !p.doneAt) p.doneAt = p.updatedAt;
  await store.set(KEY(m), p);
  await store.del(LOCK(m));
  if (p.stage !== 'done') p.kicked = await kick(`/api/cron?op=step&m=${m}`);
  return { m, stage, now: p.stage, note: res.note, kicked: p.kicked ?? null };
}

export const pipeState = async () => Object.fromEntries((await store.mget([KEY('US'), KEY('KR')])).map((v, i) => [['US', 'KR'][i], v]));
