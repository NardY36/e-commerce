/// Offline-first sync for the NOVA courier app.
///
/// Typical wiring in the Flutter app:
/// ```dart
/// final db = await databaseFactory.openDatabase(path);
/// await OutboxStore.createSchema(db);
/// final service = CourierSyncService(
///   store: OutboxStore(db),
///   api: HttpSyncApi(Uri.parse('https://api.nova.et/api/courier/pings')),
///   connectivity: ConnectivityPlusAdapter(), // wraps connectivity_plus
/// )..start();
///
/// // In the field — never awaits the network:
/// await service.recordLocation(courierId: id, latitude: lat, longitude: lng);
/// await service.recordDeliveryConfirmed(courierId: id, orderId: o, latitude: lat, longitude: lng);
/// ```
library courier_sync;

export 'src/connectivity.dart';
export 'src/outbox_entry.dart';
export 'src/outbox_store.dart';
export 'src/sync_api.dart';
export 'src/sync_service.dart';
