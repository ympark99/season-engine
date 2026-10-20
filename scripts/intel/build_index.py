#!/usr/bin/env python3
"""public/data/intel/index.json 재생성 (6번) + 섹터 재료 장부 sector_news.json.
사용:
  python3 scripts/intel/build_index.py                       # 인덱스만 다시 만든다 (중간 커밋용)
  python3 scripts/intel/build_index.py --final --today 2026-10-17 --targets 83 --new 3 --changed 5 --deep 5 --full 0 --sectors 35
→ --final 이면 _meta.runs 맨 앞에 오늘 실행 기록을 넣고(최근 30개) refreshDays 를 정한다.
내 목록에서 빠졌지만 파일이 있는 종목, 파일은 없지만 기존 index 항목이 있는 종목도 그대로 둔다."""
import argparse, glob, json, os, re, subprocess, datetime

ap = argparse.ArgumentParser()
ap.add_argument('--final', action='store_true')
ap.add_argument('--today')
for k in ('targets', 'new', 'changed', 'deep', 'full', 'sectors'):
    ap.add_argument('--' + k, type=int, default=0)
a = ap.parse_args()

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
D = os.path.join(REPO, 'public/data/intel')
old = json.load(open(os.path.join(D, 'index.json')))
meta = old.get('_meta', {'rev': 1, 'refreshDays': 7, 'runs': []})
idx, bad = {}, []
for f in sorted(glob.glob(os.path.join(D, '[A-Z][A-Z]_*.json'))):
    try:
        d = json.load(open(f))
    except Exception:
        bad.append(f)
        continue
    e = {'name': d['name'], 'theme': d['theme'], 'at': d['at'], 'full': d['full']}
    if d.get('grade'):
        e['grade'] = d['grade']
    e['cp'] = [{'id': c['id'], 'd': c['d'], 'what': c['what'], 'kind': c['kind'], 'status': c['status']}
               for c in d.get('checkpoints', []) if c.get('status') not in ('완료', '취소')]
    idx[f"{d['m']}:{d['code']}"] = e
for k, v in old.items():
    if k != '_meta' and k not in idx:
        idx[k] = v

meta['rev'] = 1
if a.final:
    runs = [r for r in meta.get('runs', []) if r.get('d') != a.today]
    run = {'d': a.today, 'targets': a.targets, 'newN': a.new, 'changed': a.changed, 'deep': a.deep,
           'full': a.full, 'sectors': a.sectors}
    meta['runs'] = ([run] + runs)[:30]
    r14 = meta['runs'][:14]
    if len(meta['runs']) >= 14 and a.targets and sum(r.get('changed', 0) for r in r14) / len(r14) < 0.1 * a.targets:
        meta['refreshDays'] = 14
    else:
        meta['refreshDays'] = 7
else:
    meta.setdefault('refreshDays', 7)
    meta.setdefault('runs', [])
idx['_meta'] = meta
json.dump(idx, open(os.path.join(D, 'index.json'), 'w'), ensure_ascii=False, indent=1)
print(len(idx) - 1, 'entries; bad files:', bad, '; refreshDays', meta['refreshDays'])

# 섹터 재료 장부 (sector_news.json) — 종목 파일의 최근 45일 updates 를 섹터별로 쓰기 좋게 한 줄씩. 전체 조사·첫 등록 요약 줄은 소식이 아니라 뺀다.
asof = a.today or datetime.date.today().isoformat()
cut = (datetime.date.fromisoformat(asof) - datetime.timedelta(days=45)).isoformat()
news = []
for f in sorted(glob.glob(os.path.join(D, '[A-Z][A-Z]_*.json'))):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    src = d.get('sources', [])
    for u in d.get('updates', []):
        dd, note = u.get('d') or '', (u.get('note') or '').strip()
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', dd) or dd < cut or not note or note.startswith(('전체 조사', '첫 등록', '예시 등록')):
            continue
        sv = u.get('src')
        k = sv[0] if isinstance(sv, list) and sv else sv if isinstance(sv, int) else None
        url = src[k].get('u') if isinstance(k, int) and 0 <= k < len(src) else None
        news.append({'m': d['m'], 'code': d['code'], 'name': d['name'], 'theme': d.get('theme'), 'd': dd, 'note': note,
                     'tone': u.get('tone') if u.get('tone') in ('호재', '악재', '중립') else None,
                     'scope': u.get('scope') if u.get('scope') in ('구조적', '일회성') else None, 'u': url})
news.sort(key=lambda x: (x['d'], x['m'], x['code']), reverse=True)
json.dump({'asof': asof, 'items': news[:600]}, open(os.path.join(D, 'sector_news.json'), 'w'), ensure_ascii=False, indent=1)
print('sector_news', len(news), 'items (tone 있음', sum(1 for x in news if x['tone']), ')')
