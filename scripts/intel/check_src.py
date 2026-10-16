#!/usr/bin/env python3
"""모든 종목 파일: JSON 파싱 + axes·checkpoints·metrics·updates 의 src 번호가 sources 길이 안인지 검사.
문제가 있으면 목록을 출력하고 종료코드 1."""
import glob, json, os, subprocess

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
bad = 0
for f in sorted(glob.glob(os.path.join(REPO, 'public/data/intel/[A-Z][A-Z]_*.json'))):
    name = os.path.basename(f)
    try:
        d = json.load(open(f))
    except Exception as e:
        print(name, 'PARSE', e)
        bad += 1
        continue
    n = len(d.get('sources', []))

    def chk(where, src):
        global bad
        for i in (src or []):
            if not isinstance(i, int) or i < 0 or i >= n:
                print(name, where, src, 'sources=', n)
                bad += 1
                break

    for a in d.get('axes', []):
        chk('axis ' + a.get('k', ''), a.get('src'))
    for c in d.get('checkpoints', []):
        chk('cp ' + c.get('id', ''), c.get('src'))
    for m in d.get('metrics', []):
        chk('metric', m.get('src'))
    for u in d.get('updates', []):
        chk('upd', u.get('src'))
    if not d.get('grade'):
        print(name, 'NO_GRADE')
        bad += 1
print('bad', bad)
raise SystemExit(1 if bad else 0)
