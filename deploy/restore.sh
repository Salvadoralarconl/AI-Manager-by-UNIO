#!/usr/bin/env bash
# Restore a backup made by deploy/backup.sh.
#
#   bash deploy/restore.sh backups/20261103T020000Z          asks you to type RESTORE
#   bash deploy/restore.sh backups/20261103T020000Z --yes    no prompt
#
# Steps:
#   1. Verify the backup's checksums.
#   2. Back up the current state first (folder labelled "pre-restore"),
#      unless --no-safety-backup is given.
#   3. Stop web, runner and proxy so nothing writes during the restore.
#   4. Replace the database and project files in the data volume
#      (demo data is left alone).
#   5. Start the stack again.
#
# Runs that were in progress when the backup was taken come back with an
# unknown outcome. The runner's recovery marks them for review rather than
# repeating them, so check Attention items in the dashboard afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="" YES=0 SAFETY=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    --no-safety-backup) SAFETY=0; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) SRC="$1"; shift ;;
  esac
done
[[ -n "$SRC" ]] || { echo "usage: $0 <backup-folder> [--yes] [--no-safety-backup]" >&2; exit 2; }
SRC=$(realpath "$SRC")
[[ -f .env ]] || { echo "missing .env in $(pwd)" >&2; exit 1; }
[[ -f "$SRC/files.tar.gz" && -f "$SRC/SHA256SUMS" ]] || { echo "not a backup folder: $SRC" >&2; exit 1; }

echo "Verifying $SRC ..."
(cd "$SRC" && sha256sum -c --quiet SHA256SUMS)
[[ -f "$SRC/manifest.txt" ]] && sed 's/^/  /' "$SRC/manifest.txt"
[[ -f "$SRC/app.db" ]] || echo "  note: this backup has no database (it was taken before first start)"

if [[ $YES -ne 1 ]]; then
  read -r -p "This replaces the current database and project files. Type RESTORE to continue: " ans
  [[ "$ans" == "RESTORE" ]] || { echo "Aborted, nothing changed."; exit 1; }
fi

if [[ $SAFETY -eq 1 ]]; then
  echo "Backing up the current state first..."
  BACKUP_KEEP=0 bash deploy/backup.sh --label pre-restore
fi

# A throwaway container from the app image, attached to the data volume.
# Backup files are streamed in on stdin, so it needs no access to the backup folder.
in_app() { docker compose run --rm --no-deps -T --entrypoint sh web -euc "$1"; }

echo "Stopping services..."
docker compose --profile proxy stop web runner proxy >/dev/null 2>&1 || true

trap 'echo "RESTORE FAILED part-way. Services are stopped. To go back, run this script again with the pre-restore backup." >&2' ERR

echo "Restoring into the data volume..."
# shellcheck disable=SC2016  # expanded inside the container
in_app '
  cd /data
  for f in $(ls -A | grep -vE "^(demo\.db.*|demo-projects)$" || true); do rm -rf "./$f"; done
'
in_app 'tar -xzf - -C /data' <"$SRC/files.tar.gz"
if [[ -f "$SRC/app.db" ]]; then
  in_app 'cat >/data/app.db
    node --disable-warning=ExperimentalWarning -e "
      const { DatabaseSync } = require(\"node:sqlite\");
      const r = new DatabaseSync(\"/data/app.db\", { readOnly: true }).prepare(\"PRAGMA integrity_check\").get();
      if (Object.values(r)[0] !== \"ok\") { console.error(\"restored database failed integrity_check\", r); process.exit(1); }
    "' <"$SRC/app.db"
fi
trap - ERR

echo "Starting services..."
docker compose up -d
echo "Restore complete. Check health with: docker compose ps"
