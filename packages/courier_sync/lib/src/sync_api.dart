import 'dart:convert';

import 'package:http/http.dart' as http;

import 'outbox_entry.dart';

/// Result of uploading a batch: the ids the server durably accepted. Anything not
/// in [acceptedIds] stays in the outbox and is retried next flush.
class BatchUploadResult {
  final Set<String> acceptedIds;
  const BatchUploadResult(this.acceptedIds);
}

/// Transport for pushing a batch of courier events to the backend. Interface so
/// tests can simulate partial acceptance, 5xx, and timeouts.
abstract interface class SyncApi {
  Future<BatchUploadResult> uploadBatch(List<OutboxEntry> batch);
}

/// Real HTTP implementation. Posts the whole batch in one request to keep radio
/// wake-ups (and therefore battery + data cost) low — important on prepaid plans.
class HttpSyncApi implements SyncApi {
  final Uri endpoint;
  final http.Client _client;
  final Duration timeout;

  HttpSyncApi(this.endpoint, {http.Client? client, this.timeout = const Duration(seconds: 15)})
      : _client = client ?? http.Client();

  @override
  Future<BatchUploadResult> uploadBatch(List<OutboxEntry> batch) async {
    final res = await _client
        .post(
          endpoint,
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'events': batch.map((e) => e.toJson()).toList()}),
        )
        .timeout(timeout);

    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Non-2xx: accept nothing, let the caller keep the batch for retry.
      return const BatchUploadResult(<String>{});
    }
    final body = jsonDecode(res.body) as Map<String, Object?>;
    final accepted = (body['acceptedIds'] as List?)?.cast<String>() ?? const <String>[];
    return BatchUploadResult(accepted.toSet());
  }
}
