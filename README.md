# Plex for Spool

The Plex provider for [Spool](https://github.com/spool-player/spool): link a Plex account with a code
at plex.tv/link, pick one of its servers, browse and search its libraries, play directly or through
the server's transcoder, keep watched state and resume points in sync, and skip the intros and
credits Plex has marked.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (provider API 0.2) |
| `logic/provider.mjs` | Sign-in, choosing a reachable address, catalogue, playback, item actions |
| `logic/items.mjs` | Plex JSON to Spool's item shape; markers to segments |
| `logic/events.mjs` | The server's notification socket, as change events |
| `ui/Login.qml` | The link code, then the account's servers |
| `ui/Picker.qml` | Choosing a playlist, confirming a delete |

A server is reached at whichever of its addresses answers first, local ones before remote ones and
Plex's relay last; when that address stops answering the others are tried and the one that works is
kept. Each Plex user of a server is its own account in Spool. Plex Home user switching, remote control
and watching together are not supported.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```
cmake -S sdk -B build/sdk && cmake --build build/sdk
build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 build/sdk/provider-contract-runner tests/contract.mjs
python3 sdk/spool-provider.py build .          # dist/spool.plex-<version>.tar.zst
```

To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.plex=/path/to/spool-plex`.

## Releasing

Bump `version` in `manifest.json`, then push a `v<version>` tag. The workflow runs the contract,
builds the package and attaches it with `spool-provider.json` to a GitHub release.

MPL-2.0; see LICENSE and NOTICE.
