import 'dart:async';

import 'connectivity.dart';
import 'outbox_entry.dart';
import 'outbox_store.dart';
import 'sync_api.dart';

/// Orchestrates offline-first courier telemetry.
///
/// The contract the rest of the app relies on:
///   • [record*] NEVER touches the network and NEVER throws on no-signal — it just
///     writes to the local SQLite outbox and returns. The UI stays snappy whether
///     the courier is on fibre in Bole or offline under a bridge in Megenagna.
///   • Sync happens opportunistically: on a timer, and immediately when
///     connectivity is restored. Uploads go out in batches to save battery/data.
///   • Delivery is idempotent end-to-end (client_ping_id), so retries after a
///     dropped ack never create duplicates server-side.
class CourierSyncService {
  final OutboxStore _store;
  final SyncApi _api;
  final Connectivity _connectivity;
  final Duration flushInterval;
  final int batchSize;

  Timer? _timer;
  StreamSubscription<bool>? _connSub;
  bool _flushing = false;

  CourierSyncService({
    required OutboxStore store,
    required SyncApi api,
    required Connectivity connectivity,
    this.flushInterval = const Duration(seconds: 30),
    this.batchSize = 50,
  })  : _store = store,
        _api = api,
        _connectivity = connectivity;

  /// Begin periodic + reconnect-triggered syncing.
  void start() {
    _timer ??= Timer.periodic(flushInterval, (_) => unawaited(flush()));
    _connSub ??= _connectivity.onStatusChange.listen((online) {
      // The moment we're back online, drain the backlog accumulated in the dead zone.
      if (online) unawaited(flush());
    });
  }

  Future<void> dispose() async {
    _timer?.cancel();
    _timer = null;
    await _connSub?.cancel();
    _connSub = null;
  }

  /// Queue a location breadcrumb. Returns once it is durably on disk.
  Future<void> recordLocation({
    required String courierId,
    String? orderId,
    required double latitude,
    required double longitude,
    DateTime? at,
  }) {
    return _enqueue(CourierEventKind.location, courierId, orderId, latitude, longitude, at);
  }

  /// Queue a delivery confirmation (prioritised on the next flush).
  Future<void> recordDeliveryConfirmed({
    required String courierId,
    required String orderId,
    required double latitude,
    required double longitude,
    DateTime? at,
  }) {
    return _enqueue(
        CourierEventKind.deliveryConfirmed, courierId, orderId, latitude, longitude, at);
  }

  Future<void> _enqueue(CourierEventKind kind, String courierId, String? orderId, double lat,
      double lng, DateTime? at) async {
    await _store.enqueue(OutboxEntry(
      clientPingId: generatePingId(),
      courierId: courierId,
      orderId: orderId,
      kind: kind,
      latitude: lat,
      longitude: lng,
      recordedAt: at ?? DateTime.now(),
    ));
  }

  /// How many events are still waiting to be uploaded.
  Future<int> pendingCount() => _store.pendingCount();

  /// Attempt to drain the outbox. Safe to call concurrently (re-entrancy guarded)
  /// and safe to call while offline (it simply no-ops). Keeps uploading batches
  /// until the backlog is empty or a batch fails.
  Future<void> flush() async {
    if (_flushing) return;
    if (!await _connectivity.isOnline()) return;
    _flushing = true;
    try {
      while (true) {
        final batch = await _store.nextBatch(limit: batchSize);
        if (batch.isEmpty) break;

        final result = await _api.uploadBatch(batch);
        if (result.acceptedIds.isEmpty) {
          // Whole batch failed (server down / timeout mid-sync). Count the attempt
          // and stop; we'll try again on the next tick or reconnect.
          await _store.bumpAttempts(batch.map((e) => e.clientPingId));
          break;
        }

        await _store.markSynced(result.acceptedIds);

        // Any ids the server didn't accept get an attempt bump but remain queued.
        final rejected = batch
            .map((e) => e.clientPingId)
            .where((id) => !result.acceptedIds.contains(id));
        await _store.bumpAttempts(rejected);

        if (batch.length < batchSize) break; // drained
      }
    } finally {
      _flushing = false;
    }
  }
}
