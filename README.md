# 계절엔진 (Vercel)

DS투자증권 양형모 「순환주기론」 생왕쇠사 엔진의 재구성판. 종목을 검색해 추가하는 순간 서버가
한국투자증권(KIS) API로 2년치 일봉을 조회해 국면·확률을 판정하고, 이후엔 매일 새 봉만 갱신.

## 구조
```
public/index.html        화면
public/data/macro.json   매크로 감시·범주 뷰 (Claude 가 검색·코멘트로 갱신)
public/data/ds.json      DS 시장 지표 3종 (코멘트 수치)
public/data/val/         밸류에이션 조사 가정 (경쟁·기술 갱신이 실적 발표 뒤 채움, 형식은 그 폴더 README)
api/list.js              GET  목록 판정
api/stock.js             GET  상세 차트 (2년)
api/add.js               POST 종목 추가 → KIS 즉시 조회 (관리자)
api/remove.js            POST 종목 삭제 (관리자)
api/cron.js              Vercel Cron — 평일 16:10 KST 한국 / 화~토 07:10 KST 미국 · ?op=cal 일정 요약 · ?op=earn 실적 발표 종목 즉시 재수집
api/train.js             POST DS 판정 재현 학습 (관리자)
api/meta.js · health.js  엔진 상태 · 설정 점검
lib/engine.js            판정·Ps·학습
lib/valuation.js         밸류에이션 — 유형별 3시나리오 DCF·역DCF·민감도·안전마진·미국 PER·PBR 밴드 (/api/fundamentals?val=)
lib/sectorsig.js         섹터 국면 — 내부 체력·대장주·짧은 탄력·엇갈림으로 경보(정상·주의·경고·이탈)·진입 신호·점수, 지난 1년 검증 (/api/universe?rot= 의 sig, 전략 9호)
lib/calendar.js         일정 캘린더 — 월간 매크로 지표·실적 발표·휴장 (공개 일정, 로그인 불필요). 내 종목이 실적을 발표하면 재무·컨센서스를 바로 다시 받고(op=earn) 밸류에이션 조사 대상으로 올림
lib/calalias.js         캘린더의 미국 종목 한글 이름 → 티커 (국내는 종목코드가 그대로 옴). 내 목록 미국 종목이 빠지면 /api/cron?op=cal 의 aliasMissing 에 나옴
lib/kis.js               KIS 일봉 (국내 FHKST03010100 · 해외 HHDFS76240000). 주문 기능 없음
lib/store.js             Upstash Redis REST (패키지 의존성 없음)
lib/labels.js            리포트·스크린샷 속 DS 실제 판정 (학습 정답지)
scripts/build-master.mjs 빌드 때 KIS 종목 마스터 → 검색용 master.json (실패 시 95종목 대체)
```

## 배포 (최초 1회)
1. vercel.com → Add New → Project → GitHub `season-engine` Import → Framework Preset **Other** → Deploy
2. Project → **Storage** → Create Database → **Upstash for Redis**(무료) → 이 프로젝트에 Connect
3. Project → Settings → **Environment Variables**: `KIS_APP_KEY`, `KIS_APP_SECRET`, `ADMIN_TOKEN`, `CRON_SECRET`
4. Deployments → 최신 배포 ⋯ → **Redeploy** (환경변수 반영)
5. `https://<프로젝트>.vercel.app/api/health` → 전부 true 확인
6. 사이트 [관리자 키]에 ADMIN_TOKEN 입력 → [기본 20종목 불러오기] 또는 검색해서 추가
7. 엔진 탭 → [학습 실행]

이후 GitHub `main` 에 push 하면 Vercel 이 자동 재배포.

## 로컬
```bash
KIS_APP_KEY=.. KIS_APP_SECRET=.. ADMIN_TOKEN=dev STORE_FILE=/tmp/store.json node test/dev-server.mjs 3000
```

## 일정 캘린더 (실적·매크로)
- `GET /api/cron?op=cal` — 오늘·어제 실적을 발표한 내 종목(`earnings.mineReported`, EPS·매출·영업이익 실제 vs 예상), 앞으로 7일 발표 예정(`mineSoon`), 방금 발표된 매크로 지표(전기 대비 해석 `read`)와 앞으로 7일 일정·휴장. 3시간 안에 받았으면 저장본, 관리자가 `&refresh=1` 이면 새로 받음. 화면 '매크로' 섹션 맨 위 '일정 · 발표' 카드가 이걸 쓴다.
- `op=earn` 크론 (국내 평일 16:30 KST, 미국 08:30·00:30 KST) — 내 종목이 발표했으면 발표 3시간 뒤부터 재무(+미국 컨센서스)를 7일 주기를 기다리지 않고 다시 받고, 점수·적정가를 다시 계산한다. 이미 발표 뒤에 받은 종목은 건너뛴다.
- 정기 조사(`scripts/intel/plan.py`) — 캘린더로 확인된 발표(숫자가 채워진 날)는 체크포인트가 '완료'로 바뀌길 기다리지 않고 그날 `val.json` 에 올려 밸류에이션 가정을 다시 조사한다(`earn` 에 실제·예상 숫자). 매크로는 `cal_macro.json` 으로 매크로 갱신 작업(`prompts/macro_cal.txt`)에 준다.
- 시험: `node --test test/calendar.test.mjs`
