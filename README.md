# 생왕쇠사 국면판 (Vercel)

DS투자증권 양형모 「순환주기론」 생왕쇠사 엔진의 재구성판. 종목을 검색해 추가하는 순간 서버가
한국투자증권(KIS) API로 2년치 일봉을 조회해 국면·확률을 판정하고, 이후엔 매일 새 봉만 갱신.

## 구조
```
public/index.html        화면
public/data/macro.json   매크로 감시·범주 뷰 (Claude 가 검색·코멘트로 갱신)
public/data/ds.json      DS 시장 지표 3종 (코멘트 수치)
api/list.js              GET  목록 판정
api/stock.js             GET  상세 차트 (2년)
api/add.js               POST 종목 추가 → KIS 즉시 조회 (관리자)
api/remove.js            POST 종목 삭제 (관리자)
api/cron.js              Vercel Cron — 평일 16:10 KST 한국 / 화~토 07:10 KST 미국
api/train.js             POST DS 판정 재현 학습 (관리자)
api/meta.js · health.js  엔진 상태 · 설정 점검
lib/engine.js            판정·Ps·학습
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
