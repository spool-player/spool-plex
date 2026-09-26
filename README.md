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
| `logic/profile.mjs` | Quality precedence, codec restrictions and Plex transcode parameters |
| `logic/events.mjs` | The server's notification socket, as change events |
| `ui/Login.qml` | The link code, then the account's servers |
| `ui/Picker.qml` | Choosing a playlist, confirming a delete |

Sign-in checks every advertised address with an authenticated server-root request and verifies
its machine identifier. It selects the first reachable address in preference order: local, remote,
then Plex relay. Advertised local addresses also have an HTTP fallback, which sends the server token
without TLS; prefer a working HTTPS/plex.direct connection on untrusted networks. Network failures
switch to another saved address and reconnect the notification socket; authorization errors do not
silently switch servers. Each Plex user of a server is its own Spool account. Failed sign-ins can
be retried, expired link codes are renewed, and server lists scroll for accounts with many servers.

## Playback and quality

The selected media edition is retained. Bitrate precedence is:

1. The explicit player bitrate selection.
2. Unlimited LAN mode, only on an address Plex identified as local (1 Gbit/s ceiling).
3. The standing bitrate preference.
4. Spool's measured conservative ceiling.
5. 120 Mbit/s before a successful measurement.

The explicit height selection overrides the standing height preference. Neither is bypassed by
unlimited LAN mode. Media with missing bitrate or required height analysis is negotiated rather
than assumed to fit. Direct play uses the original authenticated media-part URL. Remux preference
uses Plex's HLS transcoder with copying permitted only when the original satisfies quality and
codec requirements. Exceeding either ceiling, a restricted source codec, or force-transcode
disables copying. Plex bitrate parameters are rounded down to whole kbit/s.

Video negotiation calls Plex's universal decision endpoint before returning an HLS URL. Rejected
decisions and reported output exceeding the chosen ceilings fail instead of silently playing the
original. H.264 through Plex's Chrome profile is the portable video-transcode target; if the device
explicitly disallows H.264 and a transcode is required, playback reports an unsupported-codec error.
The returned stream metadata describes the negotiated output. Music uses its original file when
possible and Plex's music HLS endpoint when bitrate reduction or force-transcode is requested.
Transcoding requires server permission and any applicable Plex entitlement.

Timeline reports include the known duration and media part, so Plex can update resume/watched
state. Stopping releases remux/transcode sessions even if the final timeline report fails.
Favorites map to Plex's five-star user rating; removing a favorite clears that rating.

### Throughput measurement

The provider uses Spool's native authenticated **HTTP Range** probe on an existing media file,
not a synthetic Plex speed-test endpoint or a transcoding session. It inspects up to 32 entries
per movie, TV, or music library and selects an accessible media part of at least 4 MiB. Spool
performs bounded native range downloads, verifies partial-content responses, measures throughput,
and selects one, two, or four concurrent range requests. No binary response enters JavaScript.
An empty library, no eligible part in that sample, or a server/proxy that does not honor ranges
leaves the previous measurement unchanged; playback remains available with the quality order above.
This requires a Spool build whose API 0.2 `SpeedTestEndpoint` supports `range: true`.

The media-part and transcode protocols follow Plex's own
[player implementation](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/plexplayer.py)
and [decision handling](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/serverdecision.py).

### Boundaries

Plex Home managed-user switching, remote control, watch-together, external sidecar subtitle
attachment, and multi-part file chaining are not supported by this provider. Multi-part editions
are explicitly rejected instead of playing only their first file. Embedded subtitles remain
available to the player. Searches are bounded Plex hub results, not a paginated complete index;
cross-library browsing pages through libraries in server order, sorting within each library.
Playlist additions and deletion use the signed-in user's permissions; deletion requires confirmation.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```sh
python3 tools/check-sdk.py
cmake -S sdk -B build/sdk -G Ninja && cmake --build build/sdk
timeout 20s build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 timeout 20s build/sdk/provider-contract-runner tests/contract.mjs
python3 sdk/spool-provider.py build .
python3 sdk/spool-provider.py validate dist/spool.plex-0.1.0.tar.zst
```

To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.plex=/path/to/spool-plex`.

## Releasing

Bump `version` in `manifest.json` when needed, push `main`, then push the matching `v<version>` tag.
The workflow verifies pinned SDK hashes, runs the contract in Qt JIT and interpreter modes,
builds and validates the package, and attaches it with `spool-provider.json` and provenance to a
GitHub release. For the current manifest:

```sh
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

The optional `STORE_DISPATCH_TOKEN` secret asks `spool-providers` to refresh immediately; otherwise
the store discovers the release on its normal schedule. An equivalent local feed-entry command is:

```sh
python3 sdk/spool-provider.py feed dist/spool.plex-0.1.0.tar.zst \
  --url https://github.com/spool-player/spool-plex/releases/download/v0.1.0/spool.plex-0.1.0.tar.zst
```

MPL-2.0; see LICENSE and NOTICE.
