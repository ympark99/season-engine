#!/usr/bin/env bash
# 오라클 VM(Ubuntu) 에서 한 번 실행: Docker 설치 + 방화벽(80·443) 열기 + .env 자동 생성 + 기동
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER"; fi
# Ubuntu 이미지는 iptables 로 막혀 있어 80·443 을 열어야 한다 (오라클 콘솔의 보안 목록도 따로 열어야 함)
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || { sudo apt-get install -y iptables-persistent >/dev/null && sudo netfilter-persistent save; }
if [ ! -f .env ]; then
  IP=$(curl -fsS https://api.ipify.org)
  cat > .env <<ENV
DOMAIN=${IP//./-}.sslip.io
REDIS_PASSWORD=$(openssl rand -hex 24)
SRH_TOKEN=$(openssl rand -hex 24)
REDIS_MAXMEMORY=1gb
ENV
  chmod 600 .env
fi
sudo docker compose up -d
set -a; . ./.env; set +a
echo; echo "== Vercel 환경변수에 넣을 값 =="
echo "UPSTASH_REDIS_REST_URL=https://$DOMAIN"
echo "UPSTASH_REDIS_REST_TOKEN=$SRH_TOKEN"
echo "(인증서 발급에 1분쯤 걸린다. 확인: curl -s -X POST https://$DOMAIN -H 'Authorization: Bearer $SRH_TOKEN' -d '[\"PING\"]')"
