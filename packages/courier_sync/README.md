# courier_sync

Offline-first sync for the NOVA courier app. Buffers location pings and delivery
confirmations in a local **SQLite outbox** while the courier is in a
low-connectivity zone, then flushes them to the backend in **batches on reconnect**.

## Why it's built this way

Couriers in Addis routinely pass through dead zones (underpasses, dense blocks in
Merkato/Megenagna). The module is designed so that:

- **Writes never touch the network.** `recordLocation()` / `recordDeliveryConfirmed()`
  persist to SQLite and return immediately — the UI never blocks or errors on no signal.
- **Nothing is lost.** The outbox is durable across app kills and reboots.
- **Reconnect drains automatically.** A connectivity stream and a periodic timer both
  trigger a batched flush.
- **Delivery is idempotent.** Each event carries a device-generated `clientPingId`, so
  a batch re-sent after a dropped acknowledgement is deduplicated server-side (the
  backend upserts on `client_ping_id`). This is the same idempotency discipline the
  payment path uses.
- **One bad row can't stall the queue.** Repeatedly-failing ("poison") entries are
  skipped after `maxAttempts`, and delivery confirmations are uploaded ahead of
  location pings.

## Layout
```
lib/
  courier_sync.dart        barrel export + wiring example
  src/outbox_entry.dart    event model + dependency-free UUID
  src/outbox_store.dart    SQLite outbox (enqueue / nextBatch / markSynced)
  src/sync_api.dart        batch upload transport (HTTP + interface)
  src/connectivity.dart    reachability abstraction
  src/sync_service.dart    orchestrator (offline writes, batched flush)
test/
  sync_service_test.dart   offline → reconnect behaviour
```

## Run the tests
```bash
dart pub get
dart test
```
Tests run against an in-memory SQLite database via `sqflite_common_ffi`, so the exact
production code path is exercised on CI without a device or emulator.

## Wiring into the Flutter app
See the example in `lib/courier_sync.dart`. In production, `connectivity` wraps
`connectivity_plus` and the store opens a real on-device database path; the service is
started once at app launch with `..start()`.
