#!/usr/bin/env python3
"""밸류에이션 조사 파일(public/data/val) 검사 + index.json 재생성.
사용: python3 scripts/intel/check_val.py              # 전체 검사 + index.json 다시 만듦
      python3 scripts/intel/check_val.py US_MU KR_000660   # 그 파일만 검사 (index 는 안 건드림)
문제가 있으면 목록을 출력하고 종료코드 1. 형식은 public/data/val/README.md."""
import glob, json, os, subprocess, sys

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
D = os.path.join(REPO, 'public/data/val')
only = [a for a in sys.argv[1:] if not a.startswith('-')]
files = [os.path.join(D, f'{x}.json') for x in only] if only else sorted(glob.glob(os.path.join(D, '[A-Z][A-Z]_*.json')))
TYPES = {'cyc', 'growth', 'mature', 'loss', 'na'}
CONF = {'공시', '보도', '추정'}
bad, idx = [], {}


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
    for k, lo, hi in (('capexR', 0, 80), ('daR', 0, 50), ('tax', 0, 40), ('g', 0, 4.5), ('wacc', 6, 18), ('conv', 10, 120)):
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
    for x in d.get('facts', []):
        src('fact ' + str(x.get('k', '')), x.get('src'))
        if x.get('conf') not in CONF:
            bad.append(f'{name} fact.conf={x.get("conf")!r}')
    idx[f"{d.get('m')}:{d.get('code')}"] = {'at': d.get('at'), 'name': d.get('name')}

if not only:
    json.dump(idx, open(os.path.join(D, 'index.json'), 'w'), ensure_ascii=False, indent=1)
for b in bad:
    print(b)
print(f'files {len(files)} · bad {len(bad)}' + ('' if only else f' · index {len(idx)}'))
raise SystemExit(1 if bad else 0)
