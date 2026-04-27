# Restore from Backup — Runbook

This runbook covers restoring `storage/posts.db` from a backup snapshot
produced by `scripts/backup-db.sh`. It is written so a half-asleep operator
at 3 AM can follow it.

## TL;DR

```bash
sudo systemctl stop hitrapost
gunzip -c /home/ubuntu/app/storage/backups/posts-YYYY-MM-DD.db.gz \
  > /home/ubuntu/app/storage/posts.db
sudo systemctl start hitrapost
```

That's it. Everything below is for the cases where things are worse than that.

---

## 1. What gets backed up

| Path                                      | What                                | Where                |
|-------------------------------------------|-------------------------------------|----------------------|
| `storage/posts.db`                        | All app state (sql.js / SQLite)     | live DB              |
| `storage/backups/posts-YYYY-MM-DD.db.gz`  | Daily snapshots, 30-day retention   | local disk           |
| `storage/backups/monthly-YYYY-MM.db.gz`   | Monthly archive (1st of month)      | local disk           |
| `<remote>/daily/posts-YYYY-MM-DD.db.gz`   | Off-VM dailies                      | R2 / B2 / S3 / GCS   |
| `<remote>/monthly/monthly-YYYY-MM.db.gz`  | Off-VM monthlies                    | R2 / B2 / S3 / GCS   |

Media in `storage/uploads/` is **not** backed up — those are mirrored to
Cloudinary at upload time, so the URLs in the DB are the source of truth.

## 2. Pick the right snapshot

```bash
# Local
ls -lh /home/ubuntu/app/storage/backups/

# Off-VM (remote name from rclone config, e.g. "r2")
rclone ls r2:hitrapost-backups/posts-db/daily/   | sort
rclone ls r2:hitrapost-backups/posts-db/monthly/ | sort
```

Pick the latest snapshot **older than the corruption / mistake**. If you
don't know when corruption started, walk backwards from the most recent.

## 3. Restore — local snapshot still on the VM

```bash
APP_DIR=/home/ubuntu/app
BACKUP=$APP_DIR/storage/backups/posts-2026-04-26.db.gz   # pick your snapshot

# Stop the app so it can't write while we swap the file.
sudo systemctl stop hitrapost

# Keep the broken DB so you can post-mortem it.
mv $APP_DIR/storage/posts.db $APP_DIR/storage/posts.db.broken-$(date +%s)

# Decompress the snapshot into place.
gunzip -c "$BACKUP" > $APP_DIR/storage/posts.db
chown ubuntu:ubuntu $APP_DIR/storage/posts.db

# Sanity check before starting.
sqlite3 $APP_DIR/storage/posts.db 'PRAGMA integrity_check;'   # expect: ok
sqlite3 $APP_DIR/storage/posts.db 'SELECT count(*) FROM users;'

sudo systemctl start hitrapost
sudo journalctl -u hitrapost -f --since "1 min ago"
```

## 4. Restore — VM is gone, only off-VM backup exists

This is the "host died" path. You're rebuilding on a new VM.

```bash
# 1. Provision the new VM, install Node, clone the repo, install deps.
git clone git@github.com:ereencaan/social-media-automation.git /home/ubuntu/app
cd /home/ubuntu/app && npm ci

# 2. Restore env (.env is NOT in backups — keep it in 1Password / vault).
$EDITOR /home/ubuntu/app/.env

# 3. Pull latest snapshot from object storage.
sudo apt-get install -y rclone sqlite3
rclone config   # re-add the remote (creds from your password manager)

mkdir -p /home/ubuntu/app/storage
rclone copy r2:hitrapost-backups/posts-db/daily/ /tmp/restore/ --include "posts-*.db.gz"
LATEST=$(ls -t /tmp/restore/posts-*.db.gz | head -1)
gunzip -c "$LATEST" > /home/ubuntu/app/storage/posts.db
sqlite3 /home/ubuntu/app/storage/posts.db 'PRAGMA integrity_check;'

# 4. Start the app, wire nginx + certbot, point DNS.
sudo systemctl start hitrapost
```

## 5. If `integrity_check` fails

The snapshot itself is corrupt. Walk one snapshot older:

```bash
ls -t /home/ubuntu/app/storage/backups/posts-*.db.gz | head -5
# Try each, oldest acceptable wins. Monthly archives are the deepest fallback.
```

If every daily is bad, drop to the most recent monthly archive:

```bash
LATEST_MONTHLY=$(ls -t /home/ubuntu/app/storage/backups/monthly-*.db.gz | head -1)
gunzip -c "$LATEST_MONTHLY" > /home/ubuntu/app/storage/posts.db
```

Data loss = (today − snapshot date). Tell affected users.

## 6. Partial restore (recover one table without rolling back the rest)

You usually want a *targeted* restore — e.g. someone deleted all leads but
the rest of the DB is fine. Don't roll the whole DB back; pull rows from the
snapshot:

```bash
gunzip -c posts-2026-04-26.db.gz > /tmp/snapshot.db
sqlite3 /home/ubuntu/app/storage/posts.db <<SQL
ATTACH '/tmp/snapshot.db' AS snap;
INSERT OR IGNORE INTO leads SELECT * FROM snap.leads WHERE org_id = ?;
DETACH snap;
SQL
```

## 7. Verify backups are actually working

Run this **monthly** — an untested backup is a hope, not a backup.

```bash
# Latest snapshot exists, is non-empty, passes integrity check.
LATEST=$(ls -t /home/ubuntu/app/storage/backups/posts-*.db.gz | head -1)
[[ -s "$LATEST" ]] || { echo "FAIL: no recent snapshot"; exit 1; }
gunzip -c "$LATEST" | sqlite3 /tmp/restore-test.db
sqlite3 /tmp/restore-test.db 'PRAGMA integrity_check;' | grep -q '^ok$' \
  && echo "OK: $LATEST restores cleanly" \
  || echo "FAIL: $LATEST is corrupt"
rm -f /tmp/restore-test.db

# Off-VM backup is recent (< 30h old).
rclone lsl r2:hitrapost-backups/posts-db/daily/ | sort -k2,3 | tail -1
```

## 8. Setting up off-VM backups (one-time)

```bash
sudo apt-get install -y rclone

# Cloudflare R2 (recommended — zero egress, S3-compatible):
rclone config
#   n) New remote
#   name> r2
#   storage> s3
#   provider> Cloudflare
#   access_key_id> <from R2 dashboard>
#   secret_access_key> <from R2 dashboard>
#   endpoint> https://<account-id>.r2.cloudflarestorage.com
# Verify:
rclone mkdir r2:hitrapost-backups
rclone ls r2:hitrapost-backups

# Then add to crontab (sudo crontab -e on the VM):
0 3 * * * BACKUP_RCLONE_REMOTE=r2:hitrapost-backups/posts-db \
          /home/ubuntu/app/scripts/backup-db.sh \
          >> /var/log/hitrapost-backup.log 2>&1
```

Backblaze B2 works the same way (`provider> Other`, B2 endpoint).
