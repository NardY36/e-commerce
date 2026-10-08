/// Abstraction over "can I reach the backend right now?".
///
/// Kept as an interface so production can plug in connectivity_plus / a real
/// reachability probe, while tests drive online/offline transitions deterministically
/// without touching a radio.
abstract interface class Connectivity {
  /// A cheap, current best-guess of reachability.
  Future<bool> isOnline();

  /// Fires whenever connectivity flips. The sync service listens so it can flush
  /// the backlog the instant the courier leaves a dead zone.
  Stream<bool> get onStatusChange;
}
