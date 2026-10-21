#!/usr/bin/env python3
"""밸류에이션 조사 파일(public/data/val) 검사 + index.json 재생성.
사용: python3 scripts/intel/check_val.py              # 전체 검사 + index.json 다시 만듦
      python3 scripts/intel/check_val.py US_MU KR_000660   # 그 파일만 검사 (index 는 안 건드림)
      python3 scripts/intel/check_val.py --backfill          # git 이력으로 prev(직전 조사)가 없는 파일을 채움
검사하면서 파일의 `at` 이 git HEAD 의 `at` 과 다르면 HEAD 파일을 `prev`(직전 조사 가정)로 자동 기록한다 — 화면 '이전' 보기용.
문제가 있으면 목록을 출력하고 종료코드 1. 형식은 public/data/val/README.md."""
import glob, json, os, subprocess, sys

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
D = os.path.join(REPO, 'public/data/val')
only = [a for a in sys.argv[1:] if not a.startswith('-')]
BACKFILL = '--backfill' in sys.argv
files = [os.path.join(D, f'{x}.json') for x in only] if only else sorted(glob.glob(os.path.join(D, '[A-Z][A-Z]_*.json')))
TYPES = {'cyc', 'growth', 'mature', 'loss', 'na'}
CONF = {'공시', '보도', '추정'}
bad, idx = [], {}


def git_json(rev, path):
    r = subprocess.run(['git', 'show', f'{rev}:{path}'], capture_output=True, text=True, cwd=REPO)
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def strip_prev(d):
    return {k: v for k, v in d.items() if k != 'prev'}


def link_prev(f, d):
    """직전 조사(`at` 이 다른 가장 가까운 이전 버전)를 d['prev'] 로 넣는다. 바뀌었으면 True."""
    rel = os.path.relpath(f, REPO)
    if BACKFILL:
        if d.get('prev'):
            return False
        revs = subprocess.run(['git', 'log', '--format=%H', '--', rel], capture_output=True, text=True, cwd=REPO).stdout.split()
        for rv in revs:
            old = git_json(rv, rel)
            if old and old.get('at') and old['at'] != d.get('at'):
                d['prev'] = strip_prev(old)
                return True
        return False
    head = git_json('HEAD', rel)
    if not head or not head.get('at'):
        return False
    new = strip_prev(head) if head['at'] != d.get('at') else head.get('prev')
    if new and d.get('prev') != new:
        d['prev'] = new
        return True
    return False


def isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def rng(name, v, lo, hi, where):
    if v is None:
        return
    if not isnum(v) or not lo <= v <= hi:
        bad.append(f'{where} {name}={v!r} (범위 {lo}~{hi})')


for f in files:
    name = os.path.basename(f)
    try:
        d = json.load(open(f))
    except Exception as e:
        bad.append(f'{name} PARSE {e}')
        continue
    if link_prev(f, d):
        json.dump(d, open(f, 'w'), ensure_ascii=False, indent=1)
        open(f, 'a').write('\n')
    n = len(d.get('sources', []))

    def src(where, a):
        for i in (a or []):
            if not isinstance(i, int) or i < 0 or i >= n:
                bad.append(f'{name} {where} src={a} sources={n}')
                break

    for k in ('m', 'code', 'name', 'at'):
        if not d.get(k):
            bad.append(f'{name} {k} 없음')
    if f"{d.get('m')}_{d.get('code')}.json" != name:
        bad.append(f'{name} m/code 가 파일 이름과 다름')
    if d.get('type') is not None and d['type'] not in TYPES:
        bad.append(f'{name} type={d["type"]!r}')
    mid = d.get('mid')
    if not isinstance(mid, dict) or not isnum(mid.get('om')):
        bad.append(f'{name} mid.om 없음')
    for k in ('mid', 'peak', 'trough'):
        x = d.get(k)
        if isinstance(x, dict):
            src(k, x.get('src'))
            if x.get('conf') is not None and x['conf'] not in CONF:
                bad.append(f'{name} {k}.conf={x["conf"]!r}')
    rng('mid.om', (mid or {}).get('om'), -50, 95, name)
    rng('trough.om', (d.get('trough') or {}).get('om'), -80, 95, name)
    rng('peak.years', (d.get('peak') or {}).get('years'), 0, 20, name)
    for k in ('netCash', 'debt'):
        if d.get(k) is not None and not isnum(d[k]):
            bad.append(f'{name} {k}={d[k]!r}')
    rng('debt', d.get('debt'), 0, 1e9, name)
    rng('kd', d.get('kd'), 0, 20, name)
    for k, lo, hi in (('capexR', 0, 80), ('daR', 0, 50), ('tax', 0, 40), ('g', 0, 4.5), ('wacc', 6, 18), ('conv', 10, 120), ('sbc', 0, 40), ('wc', -100, 150)):
        rng(k, d.get(k), lo, hi, name)
    sc = d.get('scen') or {}
    ps = []
    for k in ('bull', 'base', 'bear'):
        s = sc.get(k) or {}
        if isnum(s.get('p')):
            ps.append(s['p'])
        for key, lo, hi in (('g', -90, 300), ('om', -60, 95)):
            a = s.get(key) or []
            if not isinstance(a, list) or len(a) > 10:
                bad.append(f'{name} scen.{k}.{key} 은 10개 이하 목록')
                continue
            for v in a:
                rng(f'scen.{k}.{key}', v, lo, hi, name)
    if ps and (len(ps) != 3 or abs(sum(ps) - 100) > 1):
        bad.append(f'{name} scen p 합={sum(ps)} (3개 합 100)')
    nb = d.get('newBiz')
    if nb is not None:
        if not isinstance(nb, dict) or not nb.get('at') or not isinstance(nb.get('items', []), list):
            bad.append(f'{name} newBiz 는 {{at, items[]}}')
        else:
            for it in nb['items']:
                if not it.get('name'):
                    bad.append(f'{name} newBiz.items name 없음')
                rng('newBiz.p', it.get('p'), 0, 100, name)
                src('newBiz ' + str(it.get('name', '')), it.get('src'))
                if it.get('conf') is not None and it['conf'] not in CONF:
                    bad.append(f'{name} newBiz.conf={it["conf"]!r}')
    for x in d.get('facts', []):
        src('fact ' + str(x.get('k', '')), x.get('src'))
        if x.get('conf') not in CONF:
            bad.append(f'{name} fact.conf={x.get("conf")!r}')
    pv = d.get('prev')
    if pv is not None and (not isinstance(pv, dict) or not pv.get('at') or 'prev' in pv):
        bad.append(f'{name} prev 는 at 이 있는 직전 조사 파일(prev 안에 prev 없음)')
    idx[f"{d.get('m')}:{d.get('code')}"] = {'at': d.get('at'), 'name': d.get('name')}

if not only:
    json.dump(idx, open(os.path.join(D, 'index.json'), 'w'), ensure_ascii=False, indent=1)
for b in bad:
    print(b)
print(f'files {len(files)} · bad {len(bad)}' + ('' if only else f' · index {len(idx)}'))
raise SystemExit(1 if bad else 0)
