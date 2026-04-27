#!/usr/bin/env bash
# Nightly DB snapshot.
#   * Copies storage/posts.db to storage/backups/posts-YYYY-MM-DD.db
#   * Uses sqlite3 .backup if available (consistent online backup);
#     falls back to plain cp (sql.js writes atomically via .tmp+rename
#     so a cp is also point-in-time consistent).
#   * Keeps 30 days of dailies, 12 monthlies (1st of month).
#   * Optional off-VM upload to Cloudflare R2 / Backblaze B2 / S3 / GCS
#     via rclone — enable by setting BACKUP_RCLONE_REMOTE.
#
# Wire from cron with:
#   0 3 * * * /home/ubuntu/app/scripts/backup-db.sh >> /var/log/hitrapost-backup.log 2>&1
#
# Off-VM upload (recommended for P0.5 — "don't lose data"):
#   1. Install rclone:        curl https://rclone.org/install.sh | sudo bash
#   2. Configure a remote:    rclone config   (see docs/RESTORE.md)
#   3. Export env in cron:    BACKUP_RCLONE_REMOTE=r2:hitrapost-backups/posts-db
#                             BACKUP_RCLONE_RETENTION=30d   # optional, default 30d
#
# Restore: see docs/RESTORE.md.

set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/app}"
DB="$APP_DIR/storage/posts.db"
DIR="$APP_DIR/storage/backups"
TODAY="$(date -u +%Y-%m-%d)"
DAILY="$DIR/posts-$TODAY.db"

mkdir -p "$DIR"

if [[ ! -f "$DB" ]]; then
  echo "[backup] $DB missing, nothing to do"
  exit 0
fi

# Prefer sqlite3 .backup (transactionally safe even mid-write).
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$DAILY'"
else
  # sql.js writes via tmp+rename, so plain cp captures a consistent file.
  cp "$DB" "$DAILY"
fi

# Compress in place (saves ~70% on this DB).
gzip -f "$DAILY"
DAILY="$DAILY.gz"

# Monthly archive on the 1st of every month.
IS_FIRST_OF_MONTH=0
if [[ "$(date -u +%d)" == "01" ]]; then
  cp "$DAILY" "$DIR/monthly-$(date -u +%Y-%m).db.gz"
  IS_FIRST_OF_MONTH=1
fi

# Local retention: 30 daily snapshots, 12 monthly archives (~400 days).
find "$DIR" -maxdepth 1 -type f -name 'posts-*.db.gz'    -mtime +30  -delete
find "$DIR" -maxdepth 1 -type f -name 'monthly-*.db.gz'  -mtime +400 -delete

SIZE="$(du -h "$DAILY" | awk '{print $1}')"
echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) local ok $DAILY ($SIZE)"

# ---- Off-VM upload (optional) ------------------------------------------------
# A local-only backup dies with the VM. To survive a host loss, ship the
# snapshot to object storage. rclone speaks R2 / B2 / S3 / GCS / Drive with a
# single config — pick one in `rclone config` and set BACKUP_RCLONE_REMOTE.
if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "[backup] WARN: BACKUP_RCLONE_REMOTE set but rclone not installed; skipping off-VM upload" >&2
  else
    RETENTION="${BACKUP_RCLONE_RETENTION:-30d}"
    echo "[backup] uploading $DAILY → $BACKUP_RCLONE_REMOTE/"
    rclone copy "$DAILY" "$BACKUP_RCLONE_REMOTE/daily/" \
      --s3-no-check-bucket --transfers=1 --retries=3 --low-level-retries=10

    if [[ "$IS_FIRST_OF_MONTH" == "1" ]]; then
      rclone copy "$DIR/monthly-$(date -u +%Y-%m).db.gz" "$BACKUP_RCLONE_REMOTE/monthly/" \
        --s3-no-check-bucket --transfers=1 --retries=3 --low-level-retries=10
    fi

    # Remote retention: prune daily snapshots older than $RETENTION. We do NOT
    # prune monthly archives remotely — those are the long-tail "oh no" rescue.
    rclone delete "$BACKUP_RCLONE_REMOTE/daily/" --min-age "$RETENTION" || true

    echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) off-vm ok $BACKUP_RCLONE_REMOTE"
  fi
fi
