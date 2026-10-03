// 매일 자동 갱신 파이프라인 — 시장별로 아래 단계를 순서대로 진행한다.
//   list  내 목록 + 시장 지수 새 봉
//   scan  유니버스 전종목 새 봉·판정
//   bt    국면 신뢰도 측정 → 임계값 보정 (하루 4판)
//   fund  펀더멘털 수집 (7일 지난 종목만, 한 바퀴 끝나면 점수화)
//   pf    전략실 (5개 전략) + 시장 지표 3종
// 한 번 호출 안에서 시간 예산(기본 4분)이 남는 동안 조각을 계속 이어 돌리고, 못 끝낸 일은 vercel.json 의 예비 크론이 이어받는다.
// (자기 자신을 HTTP 로 다시 부르면 Vercel 이 무한 루프로 보고 508 로 막아서 그 방식은 쓰지 않는다)
// 동시에 두 개가 돌지 않도록 시장별 잠금을 건다.
import * as store from './store.js';
import { refresh } from './service.js';
import { INDICES, refreshIndex } from './market.js';
import { scanBatch, kstDate } from './universe.js';
import { autoStep as btStep } from '../api/backtest.js';
import { collectChunk } from '../api/fundamentals.js';
import { fillShares } from './mcap.js';
import { run as runPf } from '../api/portfolio.js';

export const STAGES = ['list', 'scan', 'bt', 'fund', 'pf', 'done'];
const KEY = m => `pipe:${m}`, LOCK = m => `pipe:lock:${m}`;
const LOCK_S = 310;                                   // 함수 최대 300초보다 조금 길게

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
  if (stage === 'fund') {
    const r = await collectChunk(m);
    if (!r.idle) return { next: r.done, note: `펀더멘털 ${r.i}/${r.total}${r.blocked ? ' — 막힘' : ''}` };
    const sh = await fillShares(m, 35000).catch(e => ({ done: true, error: e.message }));   // 재무 수집이 쉬는 동안 시가총액용 상장주식수 채우기
    return { next: sh.done, note: sh.error ? `펀더멘털 최신 · 시가총액 주식수 실패 (${sh.error.slice(0, 60)})` : `펀더멘털 최신 · 시가총액 주식수 ${sh.total - sh.left}/${sh.total}` };
  }
  if (stage === 'pf') { const r = await runPf(m); return { next: true, note: `전략실 ${r.asof || ''} 까지 (${r.processed}일 처리)` }; }
  return { next: false, note: '오늘 할 일 끝' };
}

/** 시간 예산 안에서 조각을 이어 돌린다. 잠겨 있으면 그냥 돌아감 (다른 호출이 진행 중) */
export async function step(m, { from = 'cron', budgetMs = 240_000 } = {}) {
  const t0 = Date.now();
  const got = await store.setNX(LOCK(m), { at: new Date().toISOString(), from }, LOCK_S);
  if (got !== 'OK') return { m, busy: true };
  const done = [];
  let p;
  try {
    const today = kstDate();
    p = await store.get(KEY(m));
    if (!p || p.date !== today) p = { date: today, stage: 'list', startedAt: new Date().toISOString(), log: [], errors: 0 };
    // 조각 하나가 최대 ~50초라, 예산에서 60초(짧은 예산이면 절반) 남기고 새 조각 시작을 멈춘다
    const stopAt = budgetMs - Math.min(60_000, budgetMs / 2);
    while (p.stage !== 'done' && (!done.length || Date.now() - t0 < stopAt)) {   // 최소 한 조각은 돈다
      const stage = p.stage;
      let res, failed = false;
      try {
        res = await runStage(stage, m);
        p.errors = 0;
        if (res.next) p.stage = STAGES[STAGES.indexOf(stage) + 1] || 'done';
      } catch (e) {
        failed = true;
        res = { next: false, note: `오류: ${e.message.slice(0, 160)}` };
        p.errors = (p.errors || 0) + 1;
        if (p.errors >= 3) { p.stage = STAGES[STAGES.indexOf(stage) + 1] || 'done'; res.note += ' — 3번 연속 실패로 이 단계는 건너뜀'; p.errors = 0; }
      }
      p.log = [{ at: new Date().toISOString(), stage, from, note: res.note }, ...(p.log || [])].slice(0, 40);
      p.updatedAt = new Date().toISOString();
      if (p.stage === 'done' && !p.doneAt) p.doneAt = p.updatedAt;
      await store.set(KEY(m), p);                                  // 조각마다 저장 — 중간에 끊겨도 다음 호출이 이어감
      done.push(`${stage}: ${res.note}`);
      if (failed) break;                                            // 오류가 나면 이번 호출은 멈추고 다음 크론에서 다시
    }
  } finally { await store.del(LOCK(m)); }
  return { m, now: p?.stage, steps: done, note: done[done.length - 1] || (p?.stage === 'done' ? '오늘 할 일 끝' : ''), ms: Date.now() - t0 };
}

export const pipeState = async () => Object.fromEntries((await store.mget([KEY('US'), KEY('KR')])).map((v, i) => [['US', 'KR'][i], v]));
