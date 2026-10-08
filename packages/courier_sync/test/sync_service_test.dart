import 'dart:async';

import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:test/test.dart';

import 'package:courier_sync/courier_sync.dart';

/// Connectivity we can flip on/off from the test.
class FakeConnectivity implements Connectivity {
  bool online;
  final _controller = StreamController<bool>.broadcast();
  FakeConnectivity({this.online = true});

  void setOnline(bool value) {
    online = value;
    _controller.add(value);
  }

  @override
  Future<bool> isOnline() async => online;

  @override
  Stream<bool> get onStatusChange => _controller.stream;

  Future<void> close() => _controller.close();
}

/// API that records what it received and can be toggled to simulate an outage.
class FakeApi implements SyncApi {
  final List<List<OutboxEntry>> batches = [];
  final Set<String> everAccepted = {};
  bool failing = false;

  @override
  Future<BatchUploadResult> uploadBatch(List<OutboxEntry> batch) async {
    batches.add(batch);
    if (failing) return const BatchUploadResult(<String>{});
    for (final e in batch) {
      everAccepted.add(e.clientPingId);
    }
    return BatchUploadResult(batch.map((e) => e.clientPingId).toSet());
  }
}

Future<(OutboxStore, Database)> freshStore() async {
  final db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
  await OutboxStore.createSchema(db);
  return (OutboxStore(db), db);
}

void main() {
  setUpAll(sqfliteFfiInit);

  test('records are durable offline and nothing is uploaded', () async {
    final (store, db) = await freshStore();
    final conn = FakeConnectivity(online: false);
    final api = FakeApi();
    final svc = CourierSyncService(store: store, api: api, connectivity: conn);

    await svc.recordLocation(courierId: 'c1', latitude: 9.01, longitude: 38.76);
    await svc.recordLocation(courierId: 'c1', latitude: 9.02, longitude: 38.77);

    expect(await svc.pendingCount(), 2);
    await svc.flush(); // offline: must no-op
    expect(api.batches, isEmpty);
    expect(await svc.pendingCount(), 2);
    await db.close();
  });

  test('reconnecting drains the entire backlog, delivery confirmation first', () async {
    final (store, db) = await freshStore();
    final conn = FakeConnectivity(online: false);
    final api = FakeApi();
    final svc = CourierSyncService(store: store, api: api, connectivity: conn);

    await svc.recordLocation(courierId: 'c1', orderId: 'o1', latitude: 9.0, longitude: 38.7);
    await svc.recordLocation(courierId: 'c1', orderId: 'o1', latitude: 9.1, longitude: 38.8);
    await svc.recordDeliveryConfirmed(
        courierId: 'c1', orderId: 'o1', latitude: 9.2, longitude: 38.9);

    conn.setOnline(true);
    await svc.flush();

    expect(await svc.pendingCount(), 0);
    final uploaded = api.batches.expand((b) => b).toList();
    expect(uploaded.length, 3);
    // Delivery confirmation is prioritised to the front of the batch.
    expect(uploaded.first.kind, CourierEventKind.deliveryConfirmed);
    await db.close();
  });

  test('batches respect batchSize and still drain fully', () async {
    final (store, db) = await freshStore();
    final conn = FakeConnectivity(online: true);
    final api = FakeApi();
    final svc = CourierSyncService(
        store: store, api: api, connectivity: conn, batchSize: 10);

    for (var i = 0; i < 25; i++) {
      await svc.recordLocation(courierId: 'c1', latitude: 9.0 + i / 1000, longitude: 38.7);
    }
    await svc.flush();

    expect(await svc.pendingCount(), 0);
    expect(api.batches.length, 3); // 10 + 10 + 5
    expect(api.everAccepted.length, 25);
    await db.close();
  });

  test('a server outage keeps data safe and recovers on the next flush', () async {
    final (store, db) = await freshStore();
    final conn = FakeConnectivity(online: true);
    final api = FakeApi()..failing = true;
    final svc = CourierSyncService(store: store, api: api, connectivity: conn);

    await svc.recordLocation(courierId: 'c1', latitude: 9.0, longitude: 38.7);
    await svc.flush(); // server is down
    expect(await svc.pendingCount(), 1, reason: 'nothing lost while server was down');

    api.failing = false;
    await svc.flush(); // server recovered
    expect(await svc.pendingCount(), 0);
    await db.close();
  });

  test('restored connectivity auto-triggers a flush', () async {
    final (store, db) = await freshStore();
    final conn = FakeConnectivity(online: false);
    final api = FakeApi();
    final svc = CourierSyncService(store: store, api: api, connectivity: conn)..start();

    await svc.recordLocation(courierId: 'c1', latitude: 9.0, longitude: 38.7);
    conn.setOnline(true); // fires onStatusChange -> flush
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(await svc.pendingCount(), 0);
    await svc.dispose();
    await conn.close();
    await db.close();
  });
}
