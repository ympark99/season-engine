// 외부 데이터 주소. 저장소가 공개라 제공처 이름이 코드에 그대로 드러나지 않도록 기본값은 인코딩해 둔다.
// 바꾸고 싶으면 Vercel 환경변수로 덮어쓴다 (US_FUND_STMT · US_FUND_QUOTE · KR_CNS_URL · KR_CNS_REFERER · KR_FUND_HEADERS).
const d = s => Buffer.from(s, 'base64').toString('utf8').split('').reverse().join('');

export const US_STMT = process.env.US_FUND_STMT || d('dG5lbWV0YXRzL2lwYS9tb2Mueml2bmlmLy86c3B0dGg=');
export const US_QUOTE = process.env.US_FUND_QUOTE || d('eGhzYS5ldG91cS9tb2Mueml2bmlmLy86c3B0dGg=');
export const KR_CNS = process.env.KR_CNS_URL || d('ZG5lclRyb2ZyZVBzbkN0ZWcvb2ZuSXluYXBtb0MvbW9jLmVkaXVnbmYucG1vY3cvLzpzcHR0aA==');
export const KR_REFERER = process.env.KR_CNS_REFERER || d('bW9jLmVkaXVnbmYucG1vYy8vOnNwdHRo');
export const UA = process.env.FUND_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

/** 국내 제공처가 추가 헤더를 요구할 때 — KR_FUND_HEADERS 에 JSON 으로 넣는다. 예: {"cookie":"…"} */
export function krExtraHeaders() {
  try { return process.env.KR_FUND_HEADERS ? JSON.parse(process.env.KR_FUND_HEADERS) : {}; } catch { return {}; }
}
