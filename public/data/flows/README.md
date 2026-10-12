# 매출 흐름도 조사 결과

사이트 상세 화면의 [매출 흐름도]가 이 폴더를 읽는다 (서버가 raw.githubusercontent 로 15분마다 index.json 확인).
매일 아침 매크로 정기 작업이 `https://season-engine.vercel.app/api/stock?flow=queue` 의 예약 목록을 읽어 조사하고 여기에 올린다.

## index.json
```json
{ "KR:131290": { "at": "2026-10-13", "name": "티에스이" } }
```

## {m}_{code}.json  (예: KR_131290.json, US_NVDA.json)
```json
{
  "m": "KR", "code": "131290", "name": "티에스이",
  "at": "2026-10-13", "by": "Claude 정기 조사",
  "summary": "한두 문장 — 누구에게 팔아서 어디서 매출이 나오는지",
  "cust": [ { "name": "SK하이닉스", "code": "000660", "m": "KR", "share": null, "conf": "보도", "note": "근거 한 줄" } ],
  "segs": [ { "name": "샘씨엔에스 (세라믹 STF)", "code": "252990", "m": "KR", "amt": null, "share": null, "note": "연결 자회사" } ],
  "unitSeg": "억원",
  "sources": [ { "t": "2025 사업보고서", "u": "https://..." } ]
}
```
- `cust` = 주요 매출처 (최대 8). `share` 는 매출 대비 % — 공시·실적 발표에 나온 숫자만, 모르면 null.
- `conf` = `공시`(사업보고서·10-K·실적 발표에서 확인) · `보도`(기사·IR·리포트) · `추정`(비공개 거래처를 검색으로 유추).
- `segs` = 사업부·제품·연결 자회사 (최대 8). `amt` 는 금액(국내 억원, 미국 백만 달러, unitSeg 로 표시), `share` 는 매출 비중 %.
- `code`·`m` 을 넣으면 화면에서 눌러 그 종목으로 이동한다 (국내 6자리, 미국 티커).
