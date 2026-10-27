# SQLite rollback incident and maintenance rules

## Evidence and limits

During the October 24 restart, recently visible log rows disappeared and the
database returned to an older committed state. Pre-restart logs included
`cannot start a transaction within a transaction`, and a rollback journal was
present. The persistent data mount remained attached; there is no evidence that
Docker removed the database volume. A journal alone does not prove corruption.

The strongest explanation is an uncommitted transaction on the shared native
SQLite connection. Other collector writes could join that transaction; closing
the connection would roll all of them back. The regression test reproduces this
mechanism using a real SQLite file and an independent reader. The available
logs do not identify the exact request that opened the original transaction.

The incident backup was taken after stopping the service. It therefore did not
preserve the uncommitted rows. Replaying surviving source logs recovered some
records, but complete recovery of missing historical logs cannot be claimed.

On October 28, an independent read-only connection and the service connection
returned matching counts and latest timestamps for raw stream events and game
logs. This rules out a visibility discrepancy for those checks at that moment,
not all possible future failures.

## Code protection

The initial browser BEGIN/COMMIT guard was insufficient: backend transactions
spanned awaited calls on the same connection, shutdown did not drain them, and
alternate browser SQL entry points could bypass the guard.

All backend SQLite calls now share a queue. Backend-owned transactions hold the
queue until commit or rollback, so unrelated collector writes cannot join them.
Shutdown stops admission, drains accepted ingestion and queued database work,
then closes SQLite. Compose allows 30 seconds for graceful shutdown. A rollback
failure blocks further database work instead of silently continuing.

Browser SQL entry points consistently ignore standalone legacy transaction
commands, reject mixed transaction/data statements, and cannot initialize or
close the backend connection. Browser multi-request cache updates remain
autocommitted, not atomic transactions.

These changes do not guarantee recovery from disk failure, forced termination,
or missing source logs. Tests cover rollback isolation, shutdown draining,
rollback failure, and browser transaction guard variants:

```sh
node --test headless/sqliteCoordinator.test.cjs
```

## Maintenance

- Use SQLite's online backup API before restarting or modifying a deployment.
- Check backup integrity on the backup copy; do not copy a live main database
  file alone and assume it is a consistent snapshot.
- Compare committed counts/latest timestamps before and after maintenance.
- Never force COMMIT on an unknown transaction to conceal a connection bug.
- Keep the existing data volume and backups; stage the replacement image before
  stopping the running container.
- Test repairs against a copy first. Keep one-off repair scripts outside the
  repository and retain an audit record of any production data changes.
