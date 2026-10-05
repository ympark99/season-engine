// /api/universe
//   GET                      → 최신 유니버스 국면 분포·오늘 바뀐 종목·진행 상태 (공개)
//   GET ?scan=US&secret=...  → 배치 스캔 1회 (CRON_SECRET 또는 관리자 키) — 매일 이어 돌리는 건 /api/cron 파이프라인이 한다
//   GET ?rows=US             → 전종목 판정 목록 (대시보드 '전종목 보기')
//   GET ?themes=US           → 전종목 섹터(테마) {code: 섹터} + 세부 업종 + 직접 바꾼 값
//   GET ?rot=US              → 섹터 순환(4분면) 재료 — 없으면 일봉에서 바로 계산 (일봉 없는 유니버스 종목은 먼저 채움)
//   POST {m, step:'theme', code, theme} → 종목 섹터 직접 지정 (theme 비우면 자동 분류로 되돌림) · {step:'rot'} → 4분면 재료 다시 계산
//   POST {m, step:'sector', code, sector} → 세부 업종(소분류) 직접 지정 (비우면 자동)
//   POST {m, step:'rejudge'} → 저장된 일봉으로 마지막 스캔을 현재 판정기로 다시 계산 (판정 버전이 바뀌면 첫 조회 때 자동)
//   POST {m, step:'scan'}    → 배치 스캔 1회 (화면에서 수동 진행), {step:'members', force} → 구성종목 갱신
import * as store from '../lib/store.js';
import { send, body, isAdmin } from '../lib/service.js';
import { scanBatch, scanState, members, UNIV_SETS, SET_NAME, sectorMap, themesFor, buildRotation, rejudge, fillMissing, ensureRecent } from '../lib/universe.js';
import { JUDGE_REV } from '../lib/engine2.js';
import { AI_SETS } from '../lib/aiset.js';
import { THEMES, GROUPS, themeOf, ovrKey, loadOvr, secOvrKey, loadSecOvr, THEME_REV } from '../lib/themes.js';

const mOf = v => (v === 'KR' ? 'KR' : v === 'US' ? 'US' : null);

const okCron = req => process.env.CRON_SECRET && (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` || req.query.secret === process.env.CRON_SECRET);

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req), cron = okCron(req);
    const scanM = req.method === 'GET' ? (req.query.scan === 'US' ? 'US' : req.query.scan === 'KR' ? 'KR' : null) : null;

    if (scanM) {
      if (!cron && !admin) return send(res, 401, { error: 'cron 전용' });
      return send(res, 200, await scanBatch(scanM, { budgetMs: 45000 }));
    }

    if (req.method === 'GET' && (req.query.rows === 'US' || req.query.rows === 'KR')) {
      const m = req.query.rows, prev = await store.get(`univ:prev:${m}`);   // 마지막으로 끝난 스캔의 전종목
      const rows = prev?.rows || {}, sec = await sectorMap(m, Object.fromEntries(Object.entries(rows).map(([c, r]) => [c, r.n])));
      const ovr = await loadOvr(m);
      for (const [c, r] of Object.entries(rows)) { r.sec = sec[c] || null; r.th = ovr[c] || themeOf(m, c, r.sec); }
      return send(res, 200, { m, date: prev?.date || null, rows });
    }

    if (req.method === 'GET' && mOf(req.query.themes)) {
      const m = mOf(req.query.themes), t = await themesFor(m);
      return send(res, 200, { m, themes: THEMES[m], groups: GROUPS[m], map: t.map, sec: t.sec, ovr: t.ovr, secOvr: await loadSecOvr(m) });
    }

    if (req.method === 'GET' && mOf(req.query.rot)) {
      const m = mOf(req.query.rot);
      let [rot, daily] = await store.mget([`mkt:rot:${m}`, `univ:daily:${m}`]);
      // 일봉이 없는 유니버스 종목(새로 넣은 섹터 종목)을 먼저 채우고, 채운 게 있으면 4분면을 다시 계산
      if (!(await store.get(`univ:fillok:${m}:${AI_SETS[m].items.length}`)) && await store.setNX(`lock:fill:${m}`, 1, 280)) {
        try { const f = await fillMissing(m, 150000); if (f.got) rot = null; if (!f.left) await store.set(`univ:fillok:${m}:${AI_SETS[m].items.length}`, 1, 6 * 3600); } catch (e) { console.error('fill', m, e.message); } finally { await store.del(`lock:fill:${m}`); }
      }
      if (!rot || rot.rev !== THEME_REV || (daily?.at && rot.at < daily.at)) rot = (await buildRotation(m)) || rot;     // 매일 유니버스 스캔이 끝난 뒤 첫 조회 때 다시 계산
      if (!rot) return send(res, 200, { m, empty: true });
      const ovr = await loadOvr(m);
      for (const x of rot.mem) if (ovr[x.c]) x.th = ovr[x.c];
      return send(res, 200, { m, themes: THEMES[m], groups: GROUPS[m], ...rot });
    }

    if (req.method === 'POST') {
      if (!admin && !cron) return send(res, 401, { error: '관리자 키가 필요해' });
      const b = await body(req);
      const m = b.m === 'KR' ? 'KR' : 'US';
      if (b.step === 'members') {
        const mem = await members({ force: !!b.force });
        return send(res, 200, { at: mem.at, errors: mem.errors || [], counts: Object.fromEntries(Object.entries(mem.sets || {}).map(([k, v]) => [k, v.length])) });
      }
      if (b.step === 'theme') {
        const code = String(b.code || '').trim(), th = String(b.theme || '').trim();
        if (!code) return send(res, 400, { error: 'code 가 필요해' });
        if (th && th.length > 20) return send(res, 400, { error: '섹터 이름은 20자까지' });
        const ovr = await loadOvr(m);
        if (th) ovr[code] = th; else delete ovr[code];
        await store.set(ovrKey(m), ovr);
        return send(res, 200, { ok: true, code, theme: th || null, ovr });
      }
      if (b.step === 'sector') {                                              // 세부 업종(소분류) 직접 지정 — 비우면 자동으로
        const code = String(b.code || '').trim(), sec = String(b.sector || '').trim();
        if (!code) return send(res, 400, { error: 'code 가 필요해' });
        if (sec.length > 24) return send(res, 400, { error: '세부 업종은 24자까지' });
        const so = await loadSecOvr(m);
        if (sec) so[code] = sec; else delete so[code];
        await store.set(secOvrKey(m), so);
        return send(res, 200, { ok: true, code, sector: sec || null, secOvr: so });
      }
      if (b.step === 'rejudge') { const d = await rejudge(m); return send(res, 200, { ok: !!d, asof: d?.asof || null, changesN: d?.changesN ?? null, dipsN: d?.dipsN ?? null, ms: d?.rejudgeMs ?? null }); }
      if (b.step === 'rot') { const rot = await buildRotation(m); return send(res, 200, { ok: !!rot, asof: rot?.asof || null, n: rot?.n || 0 }); }
      if (b.step === 'scan') return send(res, 200, await scanBatch(m, { budgetMs: +b.budgetMs || 45000, reset: !!b.reset }));
      return send(res, 400, { error: "step 은 scan | members | theme | sector | rot | rejudge" });
    }

    // 판정기가 바뀐 뒤 첫 조회 — 마지막 스캔을 저장된 일봉으로 새 판정기 기준 다시 계산 (시장당 20~40초, 한 번만)
    await Promise.all(['US', 'KR'].map(async m => {
      const d = await store.get(`univ:daily:${m}`);
      if (!d || d.ev === JUDGE_REV) return;
      if (!(await store.setNX(`lock:rejudge:${m}`, 1, 280))) return;
      try { await rejudge(m); } catch (e) { console.error('rejudge', m, e.message); } finally { await store.del(`lock:rejudge:${m}`); }
    }));
    await Promise.all(['US', 'KR'].map(m => ensureRecent(m).catch(e => console.error('recent', m, e.message))));   // 최근 5거래일 국면 변경 (예전 결과 보강)
    const [us, kr, mem, acc, indUS, indKR] = await Promise.all([scanState('US'), scanState('KR'), store.get('univ:members'), store.get('engine:accuracy'), store.get('mkt:ind:US'), store.get('mkt:ind:KR')]);
    const counts = Object.fromEntries(Object.entries(mem?.sets || {}).map(([k, v]) => [k, v.length]));
    counts.AIX = AI_SETS.US.items.length; counts.AIK = AI_SETS.KR.items.length;              // AI 밸류체인 추가 종목 (lib/aiset.js)
    send(res, 200, {
      now: new Date().toISOString(), sets: UNIV_SETS, setName: SET_NAME,
      members: { at: mem?.at || null, counts, errors: mem?.errors || [] },
      US: { ...us, ind: indUS || null }, KR: { ...kr, ind: indKR || null }, accuracy: acc ? { at: acc.at, m: acc.m, acc: acc.acc, dwell: acc.acc?.by ? Object.fromEntries(Object.entries(acc.acc.by).map(([k, v]) => [k, v.dwell])) : null } : null,
    });
  } catch (e) { send(res, 500, { error: e.message }); }
}
