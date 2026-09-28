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
| `ui/Login.qml` | Link code, Home identity/PIN, then that identity's servers |
| `ui/Picker.qml` | Activation PIN, playlist/collection destinations, naming/order and delete confirmation |
| `logic/remote.mjs`, `logic/remote-queue.mjs` | Consent-bound Companion control and exact PMS queue mutations |
| `logic/xml.mjs` | Bounded, entity-safe XML reader for provider-owned Plex protocols |
| `logic/home.mjs` | Home XML protocol, credential roles and activation policy |
| `ui/RemoteControls.qml` | Advertised navigation, focused-field text and delegated item details |

Sign-in checks every advertised address with an authenticated server-root request and verifies
its machine identifier. It selects the first reachable address in preference order: local, remote,
then Plex relay. Advertised local addresses also have an HTTP fallback, which sends the server token
without TLS; prefer a working HTTPS/plex.direct connection on untrusted networks. Failed reads
switch to another saved address and reconnect the notification socket; mutations are not blindly
retried, and authorization errors do not silently switch servers. Each Plex user of a server is its own Spool account. Failed sign-ins can
be retried, expired link codes are renewed, and server lists scroll for accounts with many servers.

### Plex Home and device sign-in

With `spool.account-activation` version 1, linking first lists Plex Home users.
Selecting a member verifies their PIN where required, fetches that member's
Plex.tv identity/resources anew, and offers only their servers. A different
member is a separate Spool account, never a relabeled cached account.
If the optional Home enumeration endpoint returns 404, 405 or 501 for an
ordinary linked identity, sign-in continues to its server chooser. Known
Home/protected identities stay fail-closed; authentication denials, temporary
failures and malformed/empty Home rosters never downgrade them to ordinary login.

Credentials have three roles: `linkedAccountToken` enumerates/switches Home
users; `activeAccountToken` authenticates the active identity's Plex.tv
user/resources calls; `token` is the selected server's advertised resource
credential. No missing member credential falls back to the linked full identity.
Existing PMS-only accounts retain playback and PMS `/clients` discovery; add
and link an account normally to enable Home/cloud discovery. PINs are transient
form bodies, never saved configuration, URLs, logs or grants.

Protected-user switches require authentication. Startup asks for the last-used
protected user's PIN unless **Automatic sign-in** is enabled for this Home on
this device. Only an authenticated regular (not managed) Home account can
change that option in provider settings. It does not sync, does not bypass
explicit switches, and protects this Plex Home—not unrelated signed-in accounts.
Offline resume is limited to the authorized last-used automatic-sign-in identity;
offline switching fails rather than treating saved credentials as an unlock.

Prepared sources expose no artwork/catalogue or notification sockets until
activation succeeds. Cancelled/failed activation leaves the previous account
active. Same-identity accounts on other servers may reuse the core's bounded,
memory-only family proof, but validate the member token and resolve each server's
own resource token. Resource refresh never silently grants newly advertised
origins. The notification socket starts on the first normal post-commit PMS call.
Old API 0.2 hosts keep ordinary linked login and hide Home controls; protected
Home configurations fail closed and require a Spool update.

Policy follows Plex's [fast user switching documentation](https://support.plex.tv/articles/204232453-fast-user-switching/)
and its [Home XML client](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/myplexaccount.py).
Stateful Qt contract fixtures cover token separation, PIN failure, activation,
family/server identity checks, automatic/offline restrictions and old-host
fail-closed behavior; live Plex Home behavior still requires service validation.


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
Outgoing decimal tick positions are validated as nonnegative signed-64-bit values
and divided by 10,000 before numeric conversion, flooring sub-millisecond remainders.
Malformed or out-of-range positions fail before any playback request.
Favorites map to Plex's five-star user rating; removing a favorite clears that rating.

### Throughput measurement

The provider uses Spool's native authenticated **HTTP Range** probe on an existing media file,
not a synthetic Plex speed-test endpoint or a transcoding session. It inspects up to 32 entries
per movie, TV, or music library and selects an accessible media part of at least 4 MiB. Spool
performs bounded native range downloads, verifies partial-content responses, measures throughput,
and selects one, two, or four concurrent range requests. No binary response enters JavaScript.
An empty library, no eligible part in that sample, or a server/proxy that does not honor ranges
leaves the previous measurement unchanged; playback remains available with the quality order above.
This requires negotiated `spool.speed-test` version 1. It is intentionally absent
from the legacy capability list so older API 0.2 hosts do not show an unsupported
probe control. Baseline login, browsing, playback and reporting remain available
without `host.extensions`; application version strings never imply support.
Login, settings and item pickers request baseline `extensionStatus` and show
“Update Spool to use all features of this provider.” when host support is missing.
Server endpoint or permission failures are separate from host compatibility.

The media-part and transcode protocols follow Plex's own
[player implementation](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/plexplayer.py)
and [decision handling](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/serverdecision.py).

### Boundaries

Watch-together, external sidecar subtitle attachment, and multi-part file chaining
are not supported by this provider. Multi-part editions
are explicitly rejected instead of playing only their first file. Embedded subtitles remain
available to the player. Searches are bounded Plex hub results, not a paginated complete index;
cross-library browsing pages through libraries in server order, sorting within each library.
Playlist additions and deletion use the signed-in user's permissions; deletion requires confirmation.
Playlist rows retain Plex's `playlistItemID` as an opaque `entryId`, preserving the
identity of each occurrence when the same media appears more than once.

### Optional catalogue and queue features

With negotiated `spool.suggestions`, suggestions flatten accessible movie/show hubs from `/hubs`
in server order, without duplicates or Continue Watching/On Deck results. Empty recommendations
stay empty rather than borrowing resume rows.

`spool.item-actions` loads policy only when an item menu opens. Known permission denials suppress
actions; absent granular permission metadata is not an authorization grant, and the user-initiated
server operation remains authoritative. Legacy API 0.2 hosts retain their baseline playlist/delete
actions, with the same provider-side checks. Collection create/add/rename and explicit sort choices
live in the provider picker and are never exposed through legacy manifest actions.

`spool.collection-editing` lists playlist occurrences and regular collection members in native
order. Playlist removal/movement uses the exact `playlistItemID`, not the media rating key.
Collection entries use member rating keys. Smart, radio and known read-only lists cannot be edited;
collection movement requires existing custom sort. Moving an entry does not silently change sort
or fetch an entire container to translate its destination. Server 403 responses disable further
editing of that container for the source lifetime. Unknown or changed permissions still require
server authorization; collection ownership from a fresh Plex resource listing is retained.

`spool.playback-queue-reporting` prepares a private PMS play queue in a source-owned background job.
Reports continue normally while preparation runs and include PMS queue/occurrence IDs only once a
matching revision is verified. Duplicate occurrences remain distinct; membership/order revisions
reuse the existing server queue. A mixed audio/video queue reports a nonfatal unavailable status
instead of pretending one PMS queue can represent it. The implementation verifies append results
and reconciles uncertain mutations before further changes; no saved playlist is used as a surrogate.
Protocol fixtures cover these contracts; live PMS behavior still requires server-specific validation.

### Outbound Plex Companion

`spool.remote-targets` requires both `spool.http-metadata` and `spool.origin-grants`.
Opening the chooser combines PMS `/clients` with Plex.tv resources for the **active**
account identity. Accounts linked before active-account credentials were retained use
PMS discovery only; relink normally to enable cloud discovery. A linked full-account
token is never a fallback for a missing active identity.

Discovered addresses are not granted access. Selection requests host consent for the
first, HTTPS-preferred origin, verifies `/resources` identity/capabilities, and polls
`/player/timeline/poll?wait=0`. There is no callback listener, subscription, silent HTTP
downgrade, or automatic media transfer. Each source has a private controller identifier
and monotonic command IDs; poll response identity and genuine acknowledgements are
checked. Target authorization failures do not expire the PMS account.

Transport and stream controls follow the peer's advertised capabilities. Stream IDs
are Plex IDs, subtitle Off uses zero, unknown volume/duration remain absent, and mute
is not simulated by setting volume to zero. Media on a different PMS retains transport
controls but cannot expose this account's metadata, tracks or queue edits. Plex does
not advertise remote thumbnail previews.

Starting media and showing details obtain a fresh PMS delegation token. No full-account,
Home-member, resource-discovery or long-lived PMS token is sent to the peer. Unsupported
delegation or playback returns an explicit remote-play error without local fallback.
New remote queues use PMS `audio`/`video`; Companion receives `music`/`video`, the selected
variant ordinal and a verified queue container. Queue append reconciles actual count,
order and occurrence IDs, falling back to library-UUID single-item requests only after
an explicit rejected bulk append and unchanged read-back. Uncertain mutations are read
back, not blindly retried. Local playback reporting retains its separate managed queue.

Peer queue reads use `own=0`. Remove/move use exact PMS entry IDs and notify only peers
advertising `playqueues` with `refreshPlayQueue`. The documented `skipTo` command is
key-based: when duplicate media make it ambiguous, queue-play is omitted even for
queue-aware peers. Starting at a later duplicate occurrence is rejected rather than
playing the wrong occurrence; explicit Next/Previous remain available when advertised.
Shuffle randomizes the prepared queue order while retaining the explicitly selected
starting item. The provider-owned advanced panel exposes navigation and non-secure
focused-field text; details use the same transient delegation policy.

The shared XML parser accepts at most 256 KiB, 512 elements and depth 16, validates
quotes/matching tags and built-in/numeric entities, and rejects DTDs/external entities.
Stateful protocol/XML fixtures exercise the adapter; they do not establish live PMS
or Companion-device compatibility. Live service/device behavior still needs validation.
Protocol references: [Plex Companion API](https://github.com/plexinc/plex-media-player/wiki/Remote-control-API)
and [python-plexapi PMS play queues](https://github.com/pkkid/python-plexapi/blob/master/plexapi/playqueue.py).


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

## Service icon

Plex and the Plex Play logo are trademarks of Plex and used under a license. See https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/. The icon identifies the connected service; this is an independent Spool integration, not an official Plex client. See [asset attribution](assets/BRANDING.md).
