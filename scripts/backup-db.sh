#!/usr/bin/env bash
# Nightly DB snapshot.
#   * Copies storage/posts.db to storage/backups/posts-YYYY-MM-DD.db
#   * Uses sqlite3 .backup if available (consistent online backup);
#     falls back to plain cp (sql.js writes atomically via .tmp+rename
#     so a cp is also point-in-time consistent).
#   * Keeps 30 days of dailies, 12 monthlies (1st of month).
#
# OFF-VM: this script does NOT push off the VM. To add Cloudflare R2 /
# Backblaze B2 / Google Drive, append an upload step below — the snapshot
# file is in $DAILY ready to ship.
#
# Wire from cron with:
#   0 3 * * * /home/ubuntu/app/scripts/backup-db.sh >> /var/log/hitrapost-backup.log 2>&1

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
if [[ "$(date -u +%d)" == "01" ]]; then
  cp "$DAILY" "$DIR/monthly-$(date -u +%Y-%m).db.gz"
fi

# Retention: 30 daily snapshots, 12 monthly archives.
find "$DIR" -maxdepth 1 -type f -name 'posts-*.db.gz'    -mtime +30 -delete
find "$DIR" -maxdepth 1 -type f -name 'monthly-*.db.gz'  -mtime +400 -delete

SIZE="$(du -h "$DAILY" | awk '{print $1}')"
echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) ok $DAILY ($SIZE)"
