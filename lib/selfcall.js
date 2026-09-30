// 자기 자신 호출 (Vercel 함수 60초 제한을 넘는 일을 조각으로 이어 돌릴 때).
//
// 예전엔 VERCEL_URL 로 불렀는데, 이건 배포마다 붙는 고유 주소라 Vercel 기본 설정(Deployment Protection)에서
// 로그인 벽(401)에 막힌다. 응답이 빨리 오니 '보냈다'로 착각하고 체인이 조용히 끊겼다 → 수동으로 돌리기 전까지 갱신이 없던 원인.
// 이제는 운영 도메인(VERCEL_PROJECT_PRODUCTION_URL)을 먼저 쓰고, 보낸 결과를 Redis 에 남겨 화면에서 확인한다.
import * as store from './store.js';

const LOG = 'chain:log';

export function selfBase() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return null;
}

async function log(entry) {
  try {
    const cur = (await store.get(LOG)) || [];
    await store.set(LOG, [{ at: new Date().toISOString(), ...entry }, ...cur].slice(0, 40));
  } catch { /* 기록 실패는 무시 */ }
}

/**
 * path 를 비동기로 띄운다. 상대 함수가 오래 걸리면 2.5초 뒤 끊고 '보냄'으로 본다.
 * 2.5초 안에 에러 코드(401·403·404·5xx)가 오면 실패로 기록한다.
 */
export async function kick(path) {
  const base = selfBase(), sec = process.env.CRON_SECRET;
  if (!base || !sec) { await log({ path, ok: false, status: !sec ? 'CRON_SECRET 없음' : '주소 없음' }); return false; }
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}secret=${encodeURIComponent(sec)}`;
  const headers = { authorization: `Bearer ${sec}` };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  let ok = false, status;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
    status = r.status; ok = r.ok;
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') { ok = true; status = 'dispatched'; }
    else status = `error ${e.message.slice(0, 80)}`;
  }
  await log({ path, ok, status, host: base.replace(/^https:\/\//, '') });
  return ok;
}

export const chainLog = () => store.get(LOG);
