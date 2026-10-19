#!/usr/bin/env bash
# 매일 한 번 Redis 스냅샷 복사 (cron: 17 3 * * * /home/ubuntu/season-engine/infra/redis/backup.sh). 최근 7개만 둔다.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p backup
. ./.env
sudo docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE >/dev/null; sleep 5
sudo docker compose cp redis:/data/dump.rdb "backup/dump-$(date +%F).rdb"
ls -1t backup/dump-*.rdb | tail -n +8 | xargs -r rm
