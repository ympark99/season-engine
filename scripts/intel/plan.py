#!/usr/bin/env python3
"""경쟁·기술 갱신 — 1·2번(대상·분류) 준비.
사용: python3 scripts/intel/plan.py [YYYY-MM-DD]   (오늘 날짜, 기본=KST 오늘)
결과: /tmp/intel_work/ 에 targets.json, new.json, due.json, groups.json, gNN.json, val.json, sectors.json, cal.json, cal_macro.json 을 만들고 요약을 출력한다.
cal.json = 일정 캘린더 중 내 종목의 실적 발표 (방금 발표 reported · 앞으로 7일 soon) — 숫자(EPS·매출·영업이익 실제/예상)는 캘린더가 확인한 값 (/api/cron?op=cal, lib/calendar.js).
cal_macro.json = 방금 발표된 매크로 지표(전기 대비)와 앞으로 7일 일정·휴장 — 매크로 갱신·밸류에이션 조사가 참고한다.
sectors.json = 섹터(시장+업종) 단위 업황 조사 목록 (5-2번 · prompts/sector_research.txt). 종목이 아니라 섹터 전체 업황을 본다. 월·수·금만 채워지고 다른 날은 [] (SECTOR_ALWAYS=1 로 강제).
val.json = 오늘 밸류에이션 가정을 조사할 종목 (5-1번 · prompts/val_research.txt). 기준은 public/data/val/README.md.
"""
import json, os, re, sys, time, datetime, subprocess, collections, urllib.request

W = os.environ.get('INTEL_WORK', '/tmp/intel_work')
BASE = os.environ.get('SEASON_BASE', 'https://season-engine.vercel.app')   # 시험할 땐 로컬 서버 주소로
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
        req = urllib.request.Request(BASE + '/api/list', headers={'User-Agent': 'intel-plan'})
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
    return bool(re.search(r'\bET[FN]\b|PROSHARES|ULTRAPRO|DIREXION|ISHARES|\bSPDR\b', x['name'], re.I)) or (x['m'] == 'KR' and bool(brand.match(x['name'])))   # 미국 레버리지 ETF 는 이름에 ETF 가 없기도 함

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

# 5-1. 밸류에이션 가정 조사 대상 — 신규 · 실적 발표 체크포인트 완료 뒤 · 120일 경과 · 파일 없는 기존 종목(하루 VAL_BACKFILL 개)
VD = os.path.join(REPO, 'public/data/val')
VAL_NA = {'은행·금융지주', '은행', '증권', '증권·운용', '보험', '리츠', '코인', '지주'}
VAL_STALE, VAL_BACKFILL = 120, 15
os.makedirs(VD, exist_ok=True)


def earn_done(m, c):
    """경쟁·기술 파일에서 실적 체크포인트가 완료된 가장 늦은 날짜"""
    try:
        d = json.load(open(os.path.join(D, f'{m}_{c}.json')))
    except Exception:
        return None
    best = None
    for cp in d.get('checkpoints', []):
        if cp.get('kind') != '실적' or cp.get('status') != '완료':
            continue
        ds = [g.get('d') for g in cp.get('log', []) if g.get('s') == '완료' and g.get('d')] or [cp.get('d')]
        for x in ds:
            if x and re.match(r'^\d{4}-\d{2}-\d{2}$', x) and x <= today and (best is None or x > best):
                best = x
    return best


val_due, backfill = [], []
for x in targets:
    if x['theme'] in VAL_NA:
        continue
    f = os.path.join(VD, f"{x['m']}_{x['code']}.json")
    at, nb = None, False
    if os.path.exists(f):
        try:
            d = json.load(open(f))
            at, nb = d.get('at'), bool((d.get('newBiz') or {}).get('at'))
        except Exception:
            at = None
    if (x['m'], x['code']) in newkeys:
        val_due.append({**x, 'why': '신규'})
    elif not at:
        backfill.append({**x, 'why': '파일 없음'})
    else:
        e = earn_done(x['m'], x['code'])
        if e and e > at:
            val_due.append({**x, 'why': f'실적 발표 완료 {e} 뒤'})
        elif (t0 - datetime.date.fromisoformat(at)).days >= VAL_STALE:
            val_due.append({**x, 'why': f'{VAL_STALE}일 경과'})
        elif not nb:
            backfill.append({**x, 'why': '신사업 점검 전'})   # newBiz.at 이 없는 기존 파일 — 하루 VAL_BACKFILL 개씩 채움

# 5-1-a. 일정 캘린더 — 내 종목이 오늘·어제 실적을 발표했으면(숫자가 채워진 날) 체크포인트가 '완료'가 되기를 기다리지 않고 바로 조사 대상으로 올린다.
#        조사 파일이 발표일 뒤에 이미 갱신됐으면(at >= 발표일) 다시 올리지 않는다. 캘린더가 안 열리면 이 단계만 건너뛴다.
cal, cal_err = None, None
for i in range(3):
    try:
        req = urllib.request.Request(BASE + '/api/cron?op=cal', headers={'User-Agent': 'intel-plan'})
        cal = json.load(urllib.request.urlopen(req, timeout=90))
        break
    except Exception as e:
        cal_err = e
        if i < 2:
            time.sleep(10)
EP = ('date', 'when', 'eps', 'epsEst', 'epsSurprise', 'sales', 'salesEst', 'salesSurprise', 'op', 'opEst', 'opSurprise', 'show')
cal_earn = {'reported': [], 'soon': []}
cal_hit = []
if cal:
    tmap = {(x['m'], x['code']): x for x in targets}
    for kind, key in (('reported', 'mineReported'), ('soon', 'mineSoon')):
        for e in cal['earnings'][key]:
            t = tmap.get((e['m'], e['code']))
            if t:
                cal_earn[kind].append({'m': e['m'], 'code': e['code'], 'name': t['name'], 'theme': t['theme'], **{k: e.get(k) for k in EP}})
    vkeys = {(x['m'], x['code']) for x in val_due}
    for e in cal_earn['reported']:
        k = (e['m'], e['code'])
        if e['theme'] in VAL_NA:
            continue
        f = os.path.join(VD, f"{e['m']}_{e['code']}.json")
        at = None
        if os.path.exists(f):
            try:
                at = json.load(open(f)).get('at')
            except Exception:
                at = None
        if at and at >= e['date']:
            continue
        why = f"실적 발표 {e['date']} (캘린더 확인 — 숫자 채워짐)"
        if k in vkeys:
            for x in val_due:
                if (x['m'], x['code']) == k:
                    x['why'] += ' + ' + why
                    x['earn'] = {kk: e.get(kk) for kk in EP}
        else:
            val_due.append({**{kk: e[kk] for kk in ('m', 'code', 'name', 'theme')}, 'why': why, 'earn': {kk: e.get(kk) for kk in EP}})
            vkeys.add(k)
        cal_hit.append(f"{e['m']}:{e['code']}")
    json.dump({'at': cal.get('at'), 'asof': cal.get('asof'), **cal_earn, 'unmatched': cal.get('unmatched'), 'aliasMissing': cal.get('aliasMissing')}, open(f'{W}/cal.json', 'w'), ensure_ascii=False, indent=1)
    json.dump({'at': cal.get('at'), 'asof': cal.get('asof'), **cal['macro'], 'holidays': cal.get('holidays')}, open(f'{W}/cal_macro.json', 'w'), ensure_ascii=False, indent=1)
else:
    json.dump({'reported': [], 'soon': [], 'error': str(cal_err)}, open(f'{W}/cal.json', 'w'))
    json.dump({'released': [], 'upcoming': [], 'holidays': [], 'error': str(cal_err)}, open(f'{W}/cal_macro.json', 'w'))
val_due += backfill[:VAL_BACKFILL]
json.dump(val_due, open(f'{W}/val.json', 'w'), ensure_ascii=False)

# 5-2. 섹터 업황 조사 대상 — 내 목록의 (시장, 업종) 전부. 종목 소식이 없는 섹터도 업황은 본다.
sec = collections.defaultdict(list)
for x in targets:
    sec[(x['m'], x['theme'])].append(x['name'])
SECTOR_DAYS = (0, 2, 4)   # 월·수·금 (비용 절감 — 업황은 종목 소식만큼 매일 바뀌지 않는다). SECTOR_ALWAYS=1 이면 오늘도 한다
sector_day = t0.weekday() in SECTOR_DAYS or os.environ.get('SECTOR_ALWAYS') == '1'
sectors = [{'id': f's{i:02d}', 'm': m, 'theme': th, 'members': names_}
           for i, ((m, th), names_) in enumerate(sorted(sec.items()))] if sector_day else []
json.dump(sectors, open(f'{W}/sectors.json', 'w'), ensure_ascii=False)
os.makedirs(f'{W}/sres', exist_ok=True)

pd = os.path.join(REPO, 'scripts/intel/prompts')
os.makedirs(f'{W}/prompts', exist_ok=True)
for f in os.listdir(pd):
    t = open(os.path.join(pd, f)).read().replace('{TODAY}', today).replace('{REPO}', REPO).replace('{WORK}', W)
    open(f'{W}/prompts/{f}', 'w').write(t)

print(f'today={today} refreshDays={refresh}' + (' · 정기 전체 갱신 멈춤(fullOff)' if full_off else ''))
print(f'대상 {len(targets)}종목, 업종 {len({x["theme"] for x in targets})}개, ETF 제외 {excluded}')
print('신규(5번 전체 조사):', [(x['m'], x['code'], x['name'], x['theme']) for x in new])
print('정기 전체 갱신(5번):', [(x['m'], x['code'], x['name'], x['theme']) for x in due])
print(f'밸류에이션 조사(5-1번) {len(val_due)}종목 (파일 없는 기존 종목 남은 수 {max(0, len(backfill) - VAL_BACKFILL)}):', [(x['m'], x['code'], x['name'], x['why']) for x in val_due])
if cal:
    cm = json.load(open(f'{W}/cal_macro.json'))
    print(f"일정 캘린더(cal.json): 내 종목 방금 발표 {[(e['m'], e['code'], e['name'], e['date']) for e in cal_earn['reported']]} · 앞으로 7일 {[(e['m'], e['code'], e['date']) for e in cal_earn['soon']]} · 밸류에이션 조사에 올림 {cal_hit}")
    print(f"매크로(cal_macro.json): 방금 발표 {len(cm['released'])}건 {[(x['title'], x['actual'], x['prev']) for x in cm['released'] if x['major']]} · 앞으로 7일 {len(cm['upcoming'])}건 · 이름 못 맞춘 미국 종목 {cal.get('unmatched')} · 이름표 없는 내 미국 종목 {cal.get('aliasMissing')}")
else:
    print('일정 캘린더: 못 받음 —', cal_err, '→ 체크포인트 기준으로만 진행')
print(f'섹터 업황 조사(5-2번) {len(sectors)}개 섹터: sectors.json' if sectors else '섹터 업황 조사(5-2번): 오늘은 조사일(월·수·금)이 아님 — 건너뜀')
print(f'매일 확인 업종 그룹 {len(names)}개:')
for n, th in names.items():
    print(f'  {n} {th} ({len(g[th])})')
