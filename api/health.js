// GET /api/health — 설정 점검 (값은 절대 노출하지 않고 있는지만)
import { ping } from '../lib/store.js';
import { send, isAdmin } from '../lib/service.js';

export default async function handler(req, res) {
  send(res, 200, {
    redis: await ping(), kisKey: !!process.env.KIS_APP_KEY, kisSecret: !!process.env.KIS_APP_SECRET,
    adminToken: !!process.env.ADMIN_TOKEN, cronSecret: !!process.env.CRON_SECRET, youAreAdmin: isAdmin(req),
  });
}
