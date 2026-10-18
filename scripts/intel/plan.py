#!/usr/bin/env python3
"""경쟁·기술 갱신 — 1·2번(대상·분류) 준비.
사용: python3 scripts/intel/plan.py [YYYY-MM-DD]   (오늘 날짜, 기본=KST 오늘)
결과: /tmp/intel_work/ 에 targets.json, new.json, due.json, groups.json, gNN.json 을 만들고 요약을 출력한다.
"""
import json, os, re, sys, time, datetime, subprocess, collections, urllib.request

W = '/tmp/intel_work'
REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
D = os.path.join(REPO, 'public/data/intel')
today = sys.argv[1] if len(sys.argv) > 1 else (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).strftime('%Y-%m-%d')
os.makedirs(W, exist_ok=True)

idx = json.load(open(os.path.join(D, 'index.json')))
meta = idx.get('_meta', {})
refresh = meta.get('refreshDays', 7)
full_off = bool(meta.get('fullOff'))   # True 면 정기 전체 갱신 멈춤 (신규 종목 전체 조사·매일 확인·깊은 갱신은 그대로)

stocks, err = None, None
for i in range(4):
    try:
        req = urllib.request.Request('https://season-engine.vercel.app/api/list', headers={'User-Agent': 'intel-plan'})
        stocks = json.load(urllib.request.urlopen(req, timeout=120))['stocks']
        break
    except Exception as e:
        err = e
        if i < 3:
            time.sleep(30)
if stocks is None:
    print('LIST_FAIL', err, '→ index.json 종목만으로 진행')
    stocks = []
    for k, v in idx.items():
        if k == '_meta':
            continue
        m, c = k.split(':')
        stocks.append({'m': m, 'code': c, 'name': v['name'], 'theme': v['theme']})

brand = re.compile(r'^(KODEX|TIGER|ACE|RISE|SOL|HANARO|KOSEF|ARIRANG|PLUS|KIWOOM|TIMEFOLIO)', re.I)
def is_etf(x):
    return bool(re.search(r'\bET[FN]\b', x['name'], re.I)) or (x['m'] == 'KR' and bool(brand.match(x['name'])))

pick = ('m', 'code', 'name', 'theme')
targets = [{k: x[k] for k in pick} for x in stocks if x['m'] in ('US', 'KR') and not is_etf(x)]
excluded = [x['name'] for x in stocks if x['m'] in ('US', 'KR') and is_etf(x)]
files = {f[:-5] for f in os.listdir(D) if re.match(r'[A-Z]{2}_', f)}
new = [x for x in targets if f"{x['m']}_{x['code']}" not in files]
newkeys = {(x['m'], x['code']) for x in new}
t0 = datetime.date.fromisoformat(today)
due = []
for x in targets:
    k = f"{x['m']}:{x['code']}"
    if (x['m'], x['code']) in newkeys or k not in idx:
        continue
    if not full_off and (t0 - datetime.date.fromisoformat(idx[k]['full'])).days >= refresh:
        due.append(x)
dueset = {(x['m'], x['code']) for x in due}

g = collections.defaultdict(list)
for x in targets:
    if (x['m'], x['code']) in newkeys or (x['m'], x['code']) in dueset:
        continue
    g[x['theme']].append(x)
names = {}
for i, (th, l) in enumerate(sorted(g.items())):
    n = f'g{i:02d}'
    names[n] = th
    json.dump(l, open(f'{W}/{n}.json', 'w'), ensure_ascii=False)
json.dump(names, open(f'{W}/groups.json', 'w'), ensure_ascii=False)
json.dump(targets, open(f'{W}/targets.json', 'w'), ensure_ascii=False)
json.dump(new, open(f'{W}/new.json', 'w'), ensure_ascii=False)
json.dump(due, open(f'{W}/due.json', 'w'), ensure_ascii=False)
os.makedirs(f'{W}/res', exist_ok=True)

pd = os.path.join(REPO, 'scripts/intel/prompts')
os.makedirs(f'{W}/prompts', exist_ok=True)
for f in os.listdir(pd):
    t = open(os.path.join(pd, f)).read().replace('{TODAY}', today).replace('{REPO}', REPO).replace('{WORK}', W)
    open(f'{W}/prompts/{f}', 'w').write(t)

print(f'today={today} refreshDays={refresh}' + (' · 정기 전체 갱신 멈춤(fullOff)' if full_off else ''))
print(f'대상 {len(targets)}종목, 업종 {len({x["theme"] for x in targets})}개, ETF 제외 {excluded}')
print('신규(5번 전체 조사):', [(x['m'], x['code'], x['name'], x['theme']) for x in new])
print('정기 전체 갱신(5번):', [(x['m'], x['code'], x['name'], x['theme']) for x in due])
print(f'매일 확인 업종 그룹 {len(names)}개:')
for n, th in names.items():
    print(f'  {n} {th} ({len(g[th])})')
