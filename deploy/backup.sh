#!/usr/bin/env bash
# Back up AI Manager: a consistent SQLite snapshot plus every project file.
#
#   bash deploy/backup.sh               write $BACKUP_DIR/<UTC time>/
#   bash deploy/backup.sh --label NAME  append a label to the folder name
#
# Safe while the stack is running: the database is copied with VACUUM INTO,
# which takes a consistent snapshot even while web and runner are writing.
# Project files written during the copy may be caught mid-write; pause work
# in the dashboard first if you need a perfectly quiet copy.
# Demo data (demo.db, demo-projects/) and secrets (.env) are not included.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="-${2:?--label needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -f .env ]] || { echo "missing .env in $(pwd)" >&2; exit 1; }
BACKUP_DIR=$(grep -E '^BACKUP_DIR=' .env | tail -n1 | cut -d= -f2- | tr -d "'\"" || true)
BACKUP_KEEP=$(grep -E '^BACKUP_KEEP=' .env | tail -n1 | cut -d= -f2- | tr -d "'\"" || true)
BACKUP_DIR=$(realpath -m "${BACKUP_DIR:-./backups}")
BACKUP_KEEP=${BACKUP_KEEP:-14}

# A throwaway container from the app image, attached to the data volume.
in_app() { docker compose run --rm --no-deps -T --entrypoint sh web -euc "$1"; }

NAME="$(date -u +%Y%m%dT%H%M%SZ)${LABEL}"
mkdir -p "$BACKUP_DIR"
TMP="$BACKUP_DIR/.incomplete-$NAME"
rm -rf "$TMP"; mkdir -p "$TMP"; chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "Snapshotting database..."
# shellcheck disable=SC2016  # expanded inside the container
in_app '
  rm -rf /data/.backup-tmp && mkdir -p /data/.backup-tmp
  if [ -f /data/app.db ]; then
    node --disable-warning=ExperimentalWarning -e "
      const { DatabaseSync } = require(\"node:sqlite\");
      const db = new DatabaseSync(\"/data/app.db\");
      db.exec(\"PRAGMA busy_timeout = 10000\");
      db.exec(\"VACUUM INTO \x27/data/.backup-tmp/app.db\x27\");
      db.close();
      const snap = new DatabaseSync(\"/data/.backup-tmp/app.db\", { readOnly: true });
      const r = snap.prepare(\"PRAGMA integrity_check\").get();
      if (Object.values(r)[0] !== \"ok\") { console.error(\"integrity_check failed\", r); process.exit(1); }
    " >&2
    cat /data/.backup-tmp/app.db
  fi
  rm -rf /data/.backup-tmp
' >"$TMP/app.db"
[[ -s "$TMP/app.db" ]] || { echo "  (no app.db yet: fresh install)"; rm -f "$TMP/app.db"; }

echo "Archiving project files..."
# shellcheck disable=SC2016  # expanded inside the container
in_app '
  cd /data
  set -- $(ls -A | grep -vE "^(app\.db(-wal|-shm|-journal)?|demo\.db.*|demo-projects|\.backup-tmp)$" || true)
  if [ $# -gt 0 ]; then tar -czf - "$@"; else tar -czf - -T /dev/null; fi
' >"$TMP/files.tar.gz"

APP_VER=$(docker compose run --rm --no-deps -T --entrypoint node web -p 'require("./package.json").version' 2>/dev/null || echo unknown)
cat >"$TMP/manifest.txt" <<MANIFEST
created_utc=${NAME%%-*}
label=${LABEL#-}
app_version=$APP_VER
app_image=$(docker compose images -q web 2>/dev/null | head -n1 || echo unknown)
host=$(hostname)
contents=app.db (SQLite snapshot), files.tar.gz (everything else in /data except demo data)
MANIFEST
(cd "$TMP" && sha256sum ./* >SHA256SUMS)

mv "$TMP" "$BACKUP_DIR/$NAME"
trap - EXIT
echo "Backup written: $BACKUP_DIR/$NAME ($(du -sh "$BACKUP_DIR/$NAME" | cut -f1))"

# Keep the newest $BACKUP_KEEP backups. 0 disables pruning.
if [[ "$BACKUP_KEEP" =~ ^[0-9]+$ && "$BACKUP_KEEP" -gt 0 ]]; then
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r |
    tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
      rm -rf "${BACKUP_DIR:?}/$old" && echo "Pruned old backup $old"
    done
fi
