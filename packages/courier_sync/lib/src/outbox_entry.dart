import 'dart:math';

/// The kind of event a courier produces in the field.
enum CourierEventKind {
  /// A GPS breadcrumb emitted every few seconds while en route.
  location,

  /// A one-off "I handed the package over" confirmation. Higher priority than
  /// location pings — the merchant and customer are waiting on exactly this.
  deliveryConfirmed,
}

CourierEventKind _kindFromDb(String v) => switch (v) {
      'DELIVERY_CONFIRMED' => CourierEventKind.deliveryConfirmed,
      _ => CourierEventKind.location,
    };

String _kindToDb(CourierEventKind k) => switch (k) {
      CourierEventKind.deliveryConfirmed => 'DELIVERY_CONFIRMED',
      CourierEventKind.location => 'LOCATION',
    };

/// A single event sitting in the local outbox, waiting to be synced.
///
/// [clientPingId] is generated on the device. The backend treats it as a unique
/// key, so re-uploading a batch that was actually received (but whose HTTP ack we
/// never saw, because the tunnel in Megenagna dropped) is harmless — the server
/// deduplicates. This is the courier-telemetry twin of payment idempotency keys.
class OutboxEntry {
  final String clientPingId;
  final String courierId;
  final String? orderId;
  final CourierEventKind kind;
  final double latitude;
  final double longitude;

  /// When the event happened ON THE DEVICE. We trust device time, not arrival
  /// time, because an event may be uploaded minutes after it occurred.
  final DateTime recordedAt;

  /// How many times we have tried and failed to upload this entry.
  final int attempts;

  OutboxEntry({
    required this.clientPingId,
    required this.courierId,
    required this.orderId,
    required this.kind,
    required this.latitude,
    required this.longitude,
    required this.recordedAt,
    this.attempts = 0,
  });

  Map<String, Object?> toDbRow() => {
        'client_ping_id': clientPingId,
        'courier_id': courierId,
        'order_id': orderId,
        'kind': _kindToDb(kind),
        'latitude': latitude,
        'longitude': longitude,
        'recorded_at': recordedAt.toUtc().toIso8601String(),
        'attempts': attempts,
      };

  factory OutboxEntry.fromDbRow(Map<String, Object?> row) => OutboxEntry(
        clientPingId: row['client_ping_id']! as String,
        courierId: row['courier_id']! as String,
        orderId: row['order_id'] as String?,
        kind: _kindFromDb(row['kind']! as String),
        latitude: (row['latitude']! as num).toDouble(),
        longitude: (row['longitude']! as num).toDouble(),
        recordedAt: DateTime.parse(row['recorded_at']! as String),
        attempts: (row['attempts'] ?? 0) as int,
      );

  /// The JSON shape the backend's batch endpoint expects.
  Map<String, Object?> toJson() => {
        'clientPingId': clientPingId,
        'courierId': courierId,
        'orderId': orderId,
        'kind': _kindToDb(kind),
        'lat': latitude,
        'lng': longitude,
        'recordedAt': recordedAt.toUtc().toIso8601String(),
      };
}

/// Minimal dependency-free UUID v4, so the module needs no extra package just to
/// mint client ids.
String generatePingId() {
  final rng = Random.secure();
  final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}'
      '-${hex.substring(16, 20)}-${hex.substring(20)}';
}
