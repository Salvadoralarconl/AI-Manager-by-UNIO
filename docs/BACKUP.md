# Backup and restore

## What a backup contains

Each backup is a folder in `backups/` (or `BACKUP_DIR`) named by UTC time:

| File | Contents |
|---|---|
| `app.db` | Consistent snapshot of the SQLite database, made with `VACUUM INTO` and checked with `PRAGMA integrity_check` |
| `files.tar.gz` | Everything else in the data volume: project artifacts and workspaces |
| `manifest.txt` | Time, app version, image id, host |
| `SHA256SUMS` | Checksums, verified before any restore |

Not included:

- **`.env`.** It holds your secrets. Keep your own copy somewhere safe, such as a password manager. Without it you need to set a new `SESSION_SECRET` and owner password after a rebuild, and re-enter provider keys.
- **Demo data** (`demo.db`, `demo-projects/`), which can be regenerated.

Backups are safe to take while the stack is running. The database snapshot is
always consistent; a project file being written at that exact moment could be
caught half-written, so pause work in the dashboard first if that matters.

## Make a backup

```bash
cd /opt/ai-manager
bash deploy/backup.sh                    # backups/20261103T031500Z/
bash deploy/backup.sh --label pre-update # backups/20261103T031500Z-pre-update/
```

The newest `BACKUP_KEEP` backups (default 14) are kept and older ones are
removed. The nightly timer in [DEPLOY.md](DEPLOY.md#5-nightly-backups) runs the
same script at 03:15.

### Keep a copy off the server

A backup on the same disk doesn't survive that disk failing. Copy the folder
elsewhere on a schedule, for example:

```bash
rsync -a /opt/ai-manager/backups/ you@nas.local:/backups/ai-manager/
```

## Restore

```bash
cd /opt/ai-manager
ls backups/
bash deploy/restore.sh backups/20261103T031500Z
```

The script:

1. Verifies the checksums and shows the manifest.
2. Asks you to type `RESTORE`. Pass `--yes` to skip the prompt.
3. Takes a safety backup of the current state, labelled `pre-restore`. Pass `--no-safety-backup` to skip it.
4. Stops `web`, `runner` and `proxy`.
5. Replaces the database and project files in the data volume. Demo data is untouched.
6. Checks the restored database's integrity and starts the stack.

If something goes wrong, restore the `pre-restore` folder the same way.

After a restore, any run that was in progress when the backup was taken is
recovered like a crash (see DEPLOY.md): internal work is re-queued with one
attempt used, and external actions with an unknown outcome are blocked for your
review rather than repeated.

## Moving to a new server

1. On the new server, follow [DEPLOY.md](DEPLOY.md) steps 1 and 2, and copy in your saved `.env`.
2. Copy the backup folder over, for example `rsync -a old:/opt/ai-manager/backups/2026... backups/`.
3. Run `docker compose build`, then `bash deploy/restore.sh backups/<folder> --no-safety-backup`.

## Portable export

The dashboard also offers a JSON export at `GET /api/export` (logged in, no
secrets). It is good for inspection or moving records elsewhere, but use the
backup scripts above for disaster recovery: they include artifacts and restore
in one step.

## Tested

The backup and restore cycle was run end to end against the Compose stack:
records written after a backup disappeared after restoring it, project files
came back intact, the safety backup was created, and both services returned
healthy.
