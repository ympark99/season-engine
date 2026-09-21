// GET /api/meta — 엔진 탭: 학습된 파라미터·보정·라벨 재현표
import * as store from '../lib/store.js';
import { engineState, send } from '../lib/service.js';

export default async function handler(req, res) {
  try {
    const [eng, rep] = await Promise.all([engineState(), store.get('train:report')]);
    send(res, 200, { ...eng, report: rep?.report || [], missing: rep?.missing || [] });
  } catch (e) { send(res, 500, { error: e.message }); }
}
