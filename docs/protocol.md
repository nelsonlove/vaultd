# vaultd Protocol

Protocol version: `1`

The protocol is transport-neutral. The foundation's newline-delimited JSON stdio loop is a proof transport, not a production transport commitment.

## Envelope rules

Every request carries `version`, client-chosen `id`, and one tagged request. Every response echoes `id`, reports the server protocol `version`, and contains either an `ok` response or an `err` protocol error. Unknown or unsupported versions fail before operation dispatch.

Version validation precedes method dispatch. The server first reads only the envelope (`version`, `id`, and the undecoded request), so an unsupported version receives `incompatible_version` even when the request names a method this server does not know. A supported version whose method is unknown receives `invalid_request`. Both refusals echo the request `id` and leave the server running; only input without a usable envelope is a fatal input error.

```json
{"version":1,"id":"req-1","request":{"method":"health"}}
```

```json
{"version":1,"id":"req-1","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}
```

## Implemented operation

### `health`

Returns the service name and `ok` status. It performs no filesystem access.

## Reserved operation families

These names document intended boundaries and are not accepted by the version 1 Rust request enum in this milestone:

- `get_vault_info`
- `get_note`
- `resolve_link`
- `get_backlinks`
- `query`
- `search`
- `apply_mutation`
- `begin_transaction`
- `commit_transaction`
- `abort_transaction`
- `subscribe`

Mutation operations will carry expected revisions. Transaction and subscription identifiers will be opaque strings. Concrete payloads enter the protocol only with executable behavior and compatibility tests.

## Errors

Stable version 1 codes are `incompatible_version`, `invalid_request`, and `internal`. Domain errors such as missing notes and revision conflicts will receive protocol codes when their operations are introduced.

## Evolution

Adding optional fields is backward-compatible. Adding operations is backward-compatible for servers and clients that reject unknown tagged variants cleanly. Renaming fields, changing meanings, or removing variants requires a new protocol version.
