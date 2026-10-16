#!/usr/bin/env python3
"""매일 확인 결과(/tmp/intel_work/res/gNN.json)에서 changed=true 또는 peerImpact 가 있는 종목을 한 줄씩 출력한다.
첫 열이 그룹(gNN) — 깊은 갱신 에이전트에 GROUP 으로 넘긴다."""
import glob, json, os

W = '/tmp/intel_work'
n = 0
for f in sorted(glob.glob(f'{W}/res/g*.json')):
    for r in json.load(open(f)):
        n += 1
        if r.get('changed') or r.get('peerImpact'):
            cps = [(c['id'], c['status']) for c in r.get('cp', [])]
            print(os.path.basename(f)[:-5], r['m'], r['code'], '|', r.get('why'), '| cp:', cps, '| peer:', r.get('peerImpact'))
print('확인한 종목 항목 수', n)
