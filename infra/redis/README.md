# 오라클 프리티어에 Redis 올리기 (Upstash 대체)

`lib/store.js` 는 Upstash REST 방식(`POST <URL>` + `Bearer 토큰`)만 쓴다. 그래서 VM 에 Redis + REST 어댑터(SRH) + HTTPS(Caddy)를 올리고
Vercel 환경변수 두 개(`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)만 바꾸면 코드 수정 없이 옮겨진다.

## 1. 오라클 가입
1. https://www.oracle.com/cloud/free/ → **Start for free**. 이메일·국가(대한민국)·이름 입력, 메일 인증.
2. **Home Region 은 South Korea Central (Seoul) 또는 Chuncheon** 으로 (가입 후 못 바꾼다). 자원이 모자라면 다른 한국 리전 선택.
3. 카드 인증(해외결제 가능한 신용/체크카드, 1~2달러 임시 승인 후 취소). 유료 전환하지 않으면 청구되지 않는다 — 'Always Free' 자원만 쓰면 평생 무료.
4. 계정 활성화까지 몇 분~몇 시간. 메일 오면 콘솔(cloud.oracle.com) 로그인.

## 2. VM 만들기
콘솔 → **Compute → Instances → Create instance**
- 이미지: **Ubuntu 22.04** (Change image)
- Shape: **VM.Standard.A1.Flex (Ampere ARM) 1 OCPU / 6GB** — 'Always Free-eligible' 표시 확인. (자원이 없으면 VM.Standard.E2.1.Micro 1GB 도 됨, 이 경우 REDIS_MAXMEMORY=300mb)
- Networking: 기본 VCN 새로 만들기, **Assign a public IPv4 address** 켜기
- SSH keys: **Generate a key pair** → private key 다운로드해 안전하게 보관
- Boot volume 기본 50GB
- Create → 상태 Running 이 되면 **Public IP** 복사

### 포트 열기 (콘솔)
인스턴스 → Subnet → Security List → Default → **Add Ingress Rules**: Source `0.0.0.0/0`, TCP, 포트 `80,443` (두 줄로 각각)

## 3. VM 에 설치 (SSH)
```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<공인IP>
git clone https://github.com/ympark99/season-engine.git && cd season-engine/infra/redis
./setup.sh
```
`setup.sh` 가 Docker 설치·방화벽·`.env`(비밀번호·토큰 자동 생성, 도메인은 `<IP>.sslip.io`)·기동을 한 번에 한다. 끝에 출력되는 두 값이 Vercel 에 넣을 값이다.
처음 실행에서 docker 그룹 때문에 오류가 나면 `exit` 후 다시 SSH 접속해서 `./setup.sh` 를 한 번 더.

확인: 출력된 `curl -s -X POST https://… -d '["PING"]'` → `{"result":"PONG"}`

## 4. 데이터 이전 (Upstash 를 잠깐 업그레이드해 풀린 뒤)
```bash
SRC_URL=<기존 UPSTASH_REDIS_REST_URL> SRC_TOKEN=<기존 토큰> \
DST_URL=https://<도메인> DST_TOKEN=<SRH_TOKEN> node scripts/migrate_redis.mjs --dry   # 먼저 건수 확인
… node scripts/migrate_redis.mjs                                                       # 실제 복사
```
끝에 원본·새 DB 키 수가 같게 나오면 된다. 읽기만 하므로 원본은 그대로 남는다.

## 5. Vercel 전환
Vercel → 프로젝트 → Settings → Environment Variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` 을 새 값으로 (Marketplace 가 넣은 `KV_REST_API_*` 가 있으면 그것도 같은 값으로, 또는 삭제) → Redeploy.
`https://season-engine.vercel.app/api/health` 에서 `redis: true` 확인. 정상이면 Upstash 는 다시 Free 로 내리거나 삭제.

## 운영
- 백업: `crontab -e` → `17 3 * * * /home/ubuntu/season-engine/infra/redis/backup.sh` (최근 7개 dump.rdb 보관)
- 재부팅해도 컨테이너는 `restart: always` 로 자동 기동, 데이터는 appendonly 로 보존.
- 오라클은 장기간 유휴 인스턴스를 회수할 수 있으니 콘솔 알림 메일을 확인. 이 DB 는 계속 쓰이므로 보통 해당 없음.
- 보안: Redis 포트는 밖으로 열지 않는다(80·443 의 SRH 토큰 인증만 노출). `.env` 는 커밋하지 마라(`chmod 600`).
