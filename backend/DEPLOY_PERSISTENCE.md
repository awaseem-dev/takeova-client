# Persistence & deploy — READ BEFORE SHIPPING

## The problem (audit data-loss finding)

MINE uses **SQLite** — the entire database is one file at `data/mine.db` (or `$DB_PATH/mine.db`).

`railway.json` builds with NIXPACKS and **attaches no volume**. Railway's filesystem is
**ephemeral**: anything written at runtime is wiped on every redeploy, restart, or crash-restart.
So on Railway as currently configured, **all users, sites, orders, and payments are lost on
each deploy.** This is the single highest-impact correctness issue.

(Local `docker-compose.yml` is fine — it already mounts `./data:/app/data`. The problem is
the Railway target specifically.)

As of this change, the app **warns loudly at boot** when it's running SQLite in production
(`NODE_ENV=production` and no `DATABASE_URL`), printing the resolved DB path. If you see that
warning in your deploy logs, the fix below is not yet applied.

## The fix (Railway) — config, not code

1. **Attach a Volume** to the service (Railway dashboard → service → *Volumes* → add).
   Give it a mount path, e.g. `/data`.
2. **Set `DB_PATH`** to that mount path:
   ```
   DB_PATH=/data
   ```
   `db/init.js` writes `mine.db` into `DB_PATH`, so the DB file now lives on the volume and
   survives redeploys.
3. **Uploads:** user uploads currently write to `uploads/` — also ephemeral. Either put them
   on a volume too, or (better for scale) move uploads to S3. The app already reads `AWS_*`
   env vars; if S3 is configured, prefer it and treat the local `uploads/` as scratch.
4. Redeploy. The boot warning should disappear once `DATABASE_URL` is set OR the SQLite file
   is confirmed on the volume. (The warning keys off `DATABASE_URL`; if you stay on SQLite,
   the warning will still print — that's expected. Confirm via the printed path that it points
   at the mounted volume, then ignore it.)

## Already correct (no change needed)

- **WAL mode** is on (`db/init.js`) — good for concurrency and crash resilience on a volume.
- **Foreign keys** are enforced.
- `.env.example` already documents `DB_PATH` and `DATABASE_URL`.

## The bigger decision (not done here)

SQLite-on-a-volume works for a single box and is genuinely fine early on, but it doesn't survive
horizontal scaling (multiple instances can't share one SQLite file) and ties you to one host's
disk. The repo carries a **dormant Postgres path** (`db/index.js`, `db/pg-adapter.js`) that no
route uses — every route loads SQLite directly. So "switch to Postgres" is not a config flip; it's
a real migration (route-by-route, plus a data copy). Decide deliberately:

- **Stay SQLite + volume:** simplest, works now, cap is one instance. Do the volume fix above.
- **Move to Postgres:** needed for multi-instance/managed-backup. Bigger project — wire the
  adapter through the routes, migrate the 95 money columns to integer cents at the same time,
  and run it all against the test suite.

Either way, **do the volume fix above first** — it stops the active data loss today.
