import 'package:sqflite_common/sqlite_api.dart';

import 'outbox_entry.dart';

/// Durable on-device queue backed by SQLite. Survives app kills, reboots, and
/// battery death — the courier can walk through a dead zone for 20 minutes and
/// not lose a single breadcrumb.
class OutboxStore {
  final Database _db;
  OutboxStore(this._db);

  /// Creates the schema. Entries that have been uploaded are deleted, so the
  /// table only ever holds the un-synced backlog (kept small on cheap phones).
  static Future<void> createSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS outbox (
        client_ping_id TEXT PRIMARY KEY,
        courier_id     TEXT NOT NULL,
        order_id       TEXT,
        kind           TEXT NOT NULL,
        latitude       REAL NOT NULL,
        longitude      REAL NOT NULL,
        recorded_at    TEXT NOT NULL,
        attempts       INTEGER NOT NULL DEFAULT 0
      );
    ''');
  }

  /// Append an event. INSERT OR IGNORE so the same client_ping_id can't be queued
  /// twice (defensive — the caller mints a fresh id per event).
  Future<void> enqueue(OutboxEntry entry) async {
    await _db.insert(
      'outbox',
      entry.toDbRow(),
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
  }

  /// Pull the next batch to upload.
  ///
  /// Ordering reflects field priorities: delivery confirmations first (someone is
  /// waiting on them), then oldest-recorded location pings. [maxAttempts] skips
  /// "poison" entries that keep failing so one bad row can't stall the queue.
  Future<List<OutboxEntry>> nextBatch({int limit = 50, int maxAttempts = 8}) async {
    final rows = await _db.query(
      'outbox',
      where: 'attempts < ?',
      whereArgs: [maxAttempts],
      orderBy: "CASE kind WHEN 'DELIVERY_CONFIRMED' THEN 0 ELSE 1 END, recorded_at ASC",
      limit: limit,
    );
    return rows.map(OutboxEntry.fromDbRow).toList();
  }

  /// Remove entries the server has acknowledged. Done in one transaction so a
  /// crash mid-flush can't leave the outbox half-cleared.
  Future<void> markSynced(Iterable<String> clientPingIds) async {
    final ids = clientPingIds.toList();
    if (ids.isEmpty) return;
    final placeholders = List.filled(ids.length, '?').join(',');
    await _db.delete('outbox', where: 'client_ping_id IN ($placeholders)', whereArgs: ids);
  }

  /// Record a failed upload attempt so poison entries eventually fall out of the
  /// active set (see [nextBatch]).
  Future<void> bumpAttempts(Iterable<String> clientPingIds) async {
    final ids = clientPingIds.toList();
    if (ids.isEmpty) return;
    final placeholders = List.filled(ids.length, '?').join(',');
    await _db.rawUpdate(
      'UPDATE outbox SET attempts = attempts + 1 WHERE client_ping_id IN ($placeholders)',
      ids,
    );
  }

  Future<int> pendingCount() async {
    final r = await _db.rawQuery('SELECT COUNT(*) AS c FROM outbox');
    return (r.first['c'] as int?) ?? 0;
  }
}
