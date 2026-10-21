#!/usr/bin/env python3
"""섹터 업황 조사 결과(/tmp/intel_work/sres/sNN.json)를 public/data/intel/sector_outlook.json 에 합친다.
사용: python3 scripts/intel/merge_sector.py [YYYY-MM-DD]   (기본=KST 오늘)
sec[\"US:업종\"] = 오늘 업황 판단(view·note·outlook·deny·src) + 판정이 바뀐 이력 chg(최근 10개)
items = 업종 전체 소식 장부 (최근 45일) — build_index.py 가 sector_news.json 에 섞어 넣는다.
조사하지 못한(결과 파일이 없는) 섹터는 이전 판단을 그대로 둔다."""
import glob, json, os, re, subprocess, sys, datetime

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
D = os.path.join(REPO, 'public/data/intel')
W = '/tmp/intel_work'
today = sys.argv[1] if len(sys.argv) > 1 else (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).strftime('%Y-%m-%d')
cut = (datetime.date.fromisoformat(today) - datetime.timedelta(days=45)).isoformat()
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
VIEWS = ('우호', '중립', '악화')
path = os.path.join(D, 'sector_outlook.json')
try:
    out = json.load(open(path))
except Exception:
    out = {}
sec, items = out.get('sec', {}), out.get('items', [])
seen = {(x['m'], x['theme'], x['d'], x.get('u')) for x in items}
ok = bad = 0
for f in sorted(glob.glob(f'{W}/sres/s*.json')):
    try:
        r = json.load(open(f))
        m, th, v = r['m'], r['theme'], r['view']
        assert m in ('US', 'KR') and th and v in VIEWS and (r.get('note') or '').strip()
    except Exception as e:
        print('SKIP', f, e)
        bad += 1
        continue
    k = f'{m}:{th}'
    old = sec.get(k, {})
    chg = old.get('chg', [])
    if old.get('view') and old['view'] != v:
        chg = [{'d': today, 'from': old['view'], 'to': v}] + chg
    srcs = [s for s in r.get('src', []) if isinstance(s, dict) and s.get('u')]
    sec[k] = {'m': m, 'theme': th, 'at': today, 'view': v, 'note': r['note'].strip(), 'outlook': r.get('outlook'),
              'deny': r.get('deny'), 'src': srcs[:6], 'chg': chg[:10]}
    for it in r.get('items', []):
        s = it.get('src') or {}
        u, d, note = s.get('u'), it.get('d'), (it.get('note') or '').strip()
        if not (u and note and d and DATE.match(d)) or d < cut or (m, th, d, u) in seen:
            continue
        seen.add((m, th, d, u))
        items.append({'m': m, 'theme': th, 'd': d, 'note': note,
                      'tone': it.get('tone') if it.get('tone') in ('호재', '악재', '중립') else None,
                      'scope': it.get('scope') if it.get('scope') in ('구조적', '일회성') else None, 'u': u})
    ok += 1
items = sorted([x for x in items if x['d'] >= cut], key=lambda x: (x['d'], x['m'], x['theme']), reverse=True)
json.dump({'asof': today, 'sec': sec, 'items': items[:400]}, open(path, 'w'), ensure_ascii=False, indent=1)
print(f'sector_outlook: 섹터 {ok}개 반영, 건너뜀 {bad}, 판단 {len(sec)}개, 소식 {len(items)}건')
