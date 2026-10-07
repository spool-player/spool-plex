# Plex for Spool

The Plex provider for [Spool](https://github.com/spool-player/spool): link a Plex account with a code
at plex.tv/link, pick one of its servers, browse and search its libraries, play directly or through
the server's transcoder, keep watched state and resume points in sync, and skip the intros and
credits Plex has marked.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (package format 3) |
| `logic/provider.mjs` | Sign-in, choosing a reachable address, catalogue, playback, item actions |
| `logic/items.mjs` | Plex JSON to Spool's item shape; markers to segments |
| `logic/profile.mjs` | Quality precedence, codec restrictions and Plex transcode parameters |
| `logic/events.mjs` | The server's notification socket, as change events |
| `ui/Login.qml` | Plex linking/Home protocol adapter for Spool's compiled linking surface |
| `ui/Picker.qml` | Plex PIN labels, collection ordering and Companion command mappings for compiled surfaces |
| `logic/remote.mjs`, `logic/remote-queue.mjs` | Consent-bound Companion control and exact PMS queue mutations |
| `logic/xml.mjs` | Bounded, entity-safe XML reader for provider-owned Plex protocols |
| `logic/home.mjs` | Home XML protocol, credential roles and activation policy |
| `ui/Settings.qml` | Service-specific Plex Home automatic-sign-in policy |

Generic linking, PIN, item-action and advanced remote-control layouts are precompiled
into Spool. These adapters require the matching host build providing
`ProviderLinkScreen`, `ProviderActionPicker`, `ProviderRemoteControls` and
`ProviderCompatibilityNotice`; only Plex-specific flow and policy remain in this package.

Sign-in, saved-server validation, Home activation and read failover probe authenticated
server roots with at most four requests in flight and one shared four-second deadline.
The most preferred approved address that proves the expected machine identifier wins:
the last address that answered, then local, remote, Plex relay. A preferred address that
never answers cannot hold activation past the deadline. Advertised local addresses also
have an HTTP fallback, which sends the server token
without TLS; prefer a working HTTPS/plex.direct connection on untrusted networks. Failed reads
switch to another saved address that proves the same server and reconnect the notification
socket; mutations are not blindly retried, and authorization errors do not silently switch servers. Each Plex user of a server is its own Spool account. Failed sign-ins can
be retried, expired link codes are renewed, and server lists scroll for accounts with many servers.

Plex decimal-string frame rates and ratings are normalized to finite numbers
before returning media metadata. Missing file-track indexes use Spool's `-1`
analysis sentinel; library summaries and sidecar subtitles must not invent a
file track. Exact decimal file sizes are retained through the signed-64-bit
boundary, while unsafe numeric sizes and out-of-range durations remain unknown.

### Seek previews

The selected original media part's comma-separated `indexes` advertisement
controls preview availability. `hd` is preferred, with `sd` as the available
fallback; unknown or missing keys do not invent an index. Playback results carry
`{format: 'bif', url, headers}` pointing to
`/library/parts/{partId}/indexes/{hd|sd}?interval=10000`, even when playback is
transcoded. Spool decodes and caches the whole BIF sequence natively, rather than
requesting an image for every hover position. Missing or failed indexes leave
previews unavailable without failing playback.

The host's device-local `videoPreviews` flag gates local and remote BIF descriptors.
When disabled, resolve does not request `includeIndexes`; ordinary detail metadata,
artwork and markers remain available. Details never performs a preview-only request.

This follows Plex's own
[`PlexPart.getIndexPath/getIndexUrl`](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/plexpart.py)
and
[`PlexPlayer` BIF selection](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/plexplayer.py).
URLs remain on the owning PMS connection and contain no token;
`X-Plex-Token` stays in account-scoped headers and is never sent to a Companion peer.

### Offline downloads

Original downloads use the authenticated `download=1` raw-file route for the exact
selected edition and part. Ambiguous editions and multipart items open one provider
picker listing edition/part combinations; a multipart selection downloads **one part**,
not an invented concatenation. Missing files remain visibly unavailable. The picker
shows the host's original/converted mode and quality without adding a second quality control.

Converted video downloads negotiate universal `decision` with `protocol=http`, then
transfer `/video/:/transcode/universal/start.mkv?protocol=http&download=1` from offset zero.
This is a progressive Matroska media response, never an HLS/DASH playlist. Plex's own
[`buildTranscodeMkv`](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/plexplayer.py)
uses this endpoint/protocol. Server decision denials, advertised download/sync permission
denials, disabled video transcoding and rejected quality limits are explicit errors.
Audio conversion is not offered by this video endpoint; original audio remains downloadable.

Download sessions use a separate `spool-download-…` identifier and never enter the
playback reporter or alter watched state. `downloadRelease` stops that universal
session after success, error or cancellation; an already-expired session's HTTP 404
is safe to acknowledge. Transfer size is unknown for converted output; unsafe original
numeric sizes are omitted. Tokens remain in headers, never URL/log fields. Guarded debug
logs describe selection indexes and accepted protocol only.


### Plex Home and device sign-in

With `accountActivation`, linking first lists Plex Home users. The Home's
activation family is its administrator's user ID, whichever member linked the device.
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

The login worker retains these credentials privately. Home and server chooser results
contain only identity labels and connection addresses; completing a connection emits its
configuration directly to the host's private draft credential path, not QML. Adding
another Home member uses the same module's explicit `setupAccount` context to validate
the retained link and enumerate Home, without another plex.tv/link round. Resource lists
are still fetched with the newly selected member's credential. Reconnect starts a fresh
device link; cancellation prevents a pending connection from committing credentials.

Saved server-only accounts verify their PMS credential and machine identity
before activation. Missing stored credentials and rejected linked/Home-account
authentication prompt reconnect rather than publishing a successful activation.
An incorrect PIN for a protected Home member with a submitted PIN is reported as
`invalid_pin` and remains retryable, not a reason to discard credentials. An
unprotected switch returning HTTP 401 requests sign-in again, never a PIN loop.
Failed authentication never overwrites the saved tokens. A member whose resources no
longer list this server fails with `permission_denied`.

Protected-user switches require authentication. An unprotected member resumes with the
member token Plex already issued to this device; a new Home switch happens only when that
token is rejected, and never writes the linked credential. Startup asks for the last-used
protected user's PIN unless **Automatic sign-in** is enabled for this Home on
this device. Only an authenticated regular (not managed) Home account can
change that option in provider settings. It does not sync, does not bypass
explicit switches, and protects this Plex Home—not unrelated signed-in accounts.
Spool's **Always use this profile / Choose a profile at startup** controls which saved
watching profile is selected; it does not unlock a protected Plex identity or override
Plex's provider-owned skip-PIN policy.
Offline resume is limited to the authorized last-used automatic-sign-in identity;
offline switching fails rather than treating saved credentials as an unlock.

Prepared sources expose no artwork/catalogue or notification sockets until
activation succeeds. Cancelled/failed activation leaves the previous account
active. Same-identity accounts on other servers may reuse the core's bounded,
memory-only family proof, but validate the member token and resolve each server's
own resource token. Resource refresh never silently grants newly advertised
origins. The notification socket starts on the first normal post-commit PMS call.
The accountActivation capability gates Home controls; protected Home configurations
fail closed when it is unavailable.

Policy follows Plex's [fast user switching documentation](https://support.plex.tv/articles/204232453-fast-user-switching/)
and its [Home XML client](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/myplexaccount.py).
Stateful Qt contract fixtures drive the production provider's token separation, private
setup results, retained Home reuse, PIN retry, unprotected credential expiry, activation,
family/server identity checks and automatic/offline restrictions. They simulate protocol
responses and do not establish live service compatibility.


## Playback and quality

The selected media edition is retained. Bitrate precedence is:

1. The explicit player bitrate selection.
2. Unlimited LAN mode, only on an address Plex identified as local (1 Gbit/s ceiling).
3. The standing bitrate preference.
4. Spool's measured conservative ceiling.
5. 120 Mbit/s before a successful measurement.

The menu always offers **Original**, which overrides automatic and standing
limits with a 1 Gbit/s/source-resolution ceiling and bypasses the remux
preference when the original is decodable. It does not bypass device codec
restrictions or an explicit force-transcode request. Resolution rungs use fresh
selected-edition analysis, not the transcoder output or measured bandwidth.
Widescreen 3840×1608 material belongs to the 4K class; a highly compressed
5.935 Mbit/s 4K file must not hide 4K, 1080p or 720p choices.

The explicit height selection overrides the standing height preference. Neither is bypassed by
unlimited LAN mode. Media with missing bitrate or required height analysis is negotiated rather
than assumed to fit. Direct play uses the original authenticated media-part URL
with `download=1`, preserving any other part-query parameters. This is the same
file, read with normal HTTP Range streaming; it neither downloads a local copy
nor re-encodes the media. On the tested shared server, raw part URLs returned
HTTP 500, while the same URLs with `download=1` returned exact HTTP 206 ranges.
Remux preference uses Plex's HLS transcoder only when the original satisfies
quality and codec requirements and Plex agrees to copy the video. If its client
profile would re-encode that compatible original instead, Spool plays the original.
Exceeding either ceiling, a restricted source codec, or force-transcode disables
copying. Plex bitrate parameters are rounded down to whole kbit/s.

Video negotiation calls Plex's universal decision endpoint before returning an HLS URL. Rejected
decisions and reported output exceeding the chosen ceilings fail instead of silently playing the
original. H.264 through Plex's Chrome profile is the portable video-transcode target; if the device
explicitly disallows H.264 and a transcode is required, playback reports an unsupported-codec error.
The returned stream metadata describes the negotiated output. Music uses its original file when
possible and Plex's music HLS endpoint when bitrate reduction or force-transcode is requested.
Transcoding requires server permission and any applicable Plex entitlement.

Spool passes Plex's server resource token, client identifier and session
identifier as separate HTTP headers to mpv, including for shared servers
discovered through Plex. A newline-delimited provider header block must not be
passed through mpv's comma-delimited string-option parser: doing so sends one
malformed field to libcurl. A live shared-server reproduction returned HTTP 400
and mpv loading error -13 with that malformed field; the identical provider URL
with typed individual mpv headers loaded and played. The universal transcode
request and discovered account credential/address did not need a fallback or
parameter rewrite.

For local troubleshooting with sibling checkouts, run from the Spool checkout:

```sh
nix run .#local-providers -- --unredacted-urls
```

This explicitly exposes full playback URLs in Spool's local log, preserving
encoded Plex profile parameters. **Treat the log as sensitive: URL credentials
and server addresses may be visible.** Non-URL password/token fields remain
redacted; the Plex server token continues to travel in the media request headers,
not in the stream URL. Reproducing an authenticated request requires those
private headers as well. Restart without the flag to restore safe URL logging.

Timeline reports include the known duration and media part, so Plex can update resume/watched
state. Stopping releases remux/transcode sessions even if the final timeline report fails.
Timeline and transcoder cleanup acknowledgments are retained separately during
report retries. A cleanup HTTP 404 means already released only for the exact
known session/item whose playback start was acknowledged; unknown-session
404s and timeline failures remain errors. Plex can release a transcoder when
mpv unloads, before the final stop request reaches it.

HLS resume passes the full millisecond position to Plex as a fractional-second
`offset`. `timelineOriginTicks` records the corresponding source position at
normalized media zero. Spool does not issue the same resume seek again in mpv;
positions, chapters, reports and preview markers stay in source coordinates.
A live 43.7-second resume incurred roughly 31 seconds between file loading and
playback restart when mpv sought again. The server's full 43.7-second offset
with no initial mpv seek restarted in about 1.65 seconds total. Seeking before
that origin resolves a fresh stream.

Preview availability comes from the selected original part's advertised
`indexes` (`hd` preferred to `sd`), requested with `includeIndexes=1`.
Enabling preview thumbnails in Plex does not guarantee that each selected part
advertises an index to the current viewing account. When metadata omits indexes
and the corresponding BIF and Web thumbnail routes return HTTP 404, Spool leaves
previews unavailable. Compare the exact server, viewing account and media part
with the Web player before attributing this to generation or access settings;
no synthetic preview URLs or placeholder images are substituted.
Outgoing decimal tick positions are validated as nonnegative signed-64-bit values
and divided by 10,000 before numeric conversion, flooring sub-millisecond remainders.
Malformed or out-of-range positions fail before any playback request.
Favorites map to Plex's five-star user rating; removing a favorite clears that rating.

### Throughput measurement

The provider uses Spool's native authenticated **HTTP Range** probe on an existing media file
with `download=1`, not a synthetic Plex speed-test endpoint or a transcoding session.
It inspects at most eight movie, TV or music libraries and 32 entries per library,
and probes at most three distinct accessible media parts of at least 4 MiB.
If one part returns HTTP 403/404/416/500 or an invalid range sample, another
eligible part may be used; the same URL is never retried. Authentication, network
and cancellation failures stop selection immediately. Exhaustion reports the
actual final failure, not a fabricated measurement.
Spool performs bounded native range downloads, verifies partial-content responses,
measures throughput, and selects one, two, or four concurrent range requests.
No binary response enters JavaScript. A failed test retains the previous
measurement. New automatic tests wait for idle, but an in-flight bounded test
finishes if playback starts. Explicit refresh may measure during playback;
Auto shows measuring, completed or unavailable rather than endlessly cancelling
and reverting to a deferred status.
This requires negotiated `speedTest` version 1; application version strings
never imply feature support. Current provider builds require the current Spool host
contract, including native logging; older hosts are not supported. Missing declared
host features and server endpoint/permission failures are separate conditions.

The media-part and transcode protocols follow Plex's own
[player implementation](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/plexplayer.py)
and [decision handling](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/serverdecision.py).

### Boundaries

Watch-together and multi-part file chaining are not supported by this provider.
Multi-part editions are explicitly rejected instead of playing only their first file.
Embedded subtitles and external sidecar streams served from `/library/streams/`
are handed to the player; playback headers authenticate sidecar downloads.
Searches are bounded Plex hub results, not a paginated complete index;
cross-library browsing pages through libraries in server order, sorting within each library.
Playlist additions and deletion use the signed-in user's permissions; deletion requires confirmation.
Playlist rows retain Plex's `playlistItemID` as an opaque `entryId`, preserving the
identity of each occurrence when the same media appears more than once.

### Optional catalogue and queue features

With negotiated `suggestions`, suggestions flatten accessible movie/show hubs from `/hubs`
in server order, without duplicates or Continue Watching/On Deck results. Empty recommendations
stay empty rather than borrowing resume rows.

`itemActions` loads policy only when an item menu opens. Known permission denials suppress
actions; absent granular permission metadata is not an authorization grant, and the user-initiated
server operation remains authoritative. Collection create/add/rename and explicit
sort choices live in the provider picker; manifest playlist/delete actions retain
the same provider-side authorization checks.

`collectionEditing` lists playlist occurrences and regular collection members in native
order. Playlist removal/movement uses the exact `playlistItemID`, not the media rating key.
Collection entries use member rating keys. Smart, radio and known read-only lists cannot be edited;
collection movement requires existing custom sort. Moving an entry does not silently change sort
or fetch an entire container to translate its destination. Server 403 responses disable further
editing of that container for the source lifetime. Unknown or changed permissions still require
server authorization; collection ownership from a fresh Plex resource listing is retained.

`playbackQueueReporting` prepares a private PMS play queue in a source-owned background job.
Reports continue normally while preparation runs and include PMS queue/occurrence IDs only once a
matching revision is verified. Duplicate occurrences remain distinct; membership/order revisions
reuse the existing server queue. A mixed audio/video queue reports a nonfatal unavailable status
instead of pretending one PMS queue can represent it. The implementation verifies append results
and reconciles uncertain mutations before further changes; no saved playlist is used as a surrogate.
PMS omits `playQueueTotalCount` and `Metadata` from an emptied queue; an explicit `size=0`
readback acknowledges that state so replacing the last movie can append its successor to the
same queue. Missing counts on nonempty windows still fail closed. Isolated live PMS requests
confirmed ordered duplicate creation, Up Next insertion and this empty/repopulate transition;
protocol fixtures also cover stale generations and uncertain mutations.

### Outbound Plex Companion

`remoteTargets` requires both `httpMetadata` and `originGrants`.
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
controls but cannot expose this account's metadata, tracks, previews or queue edits.
Available remote BIF previews bind the timeline's exact media variant and single
original part. Unknown variants and multipart timelines do not borrow another index.

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
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
python3 sdk/spool-provider.py validate "dist/spool.plex-$VERSION.tar.zst"
```

To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.plex=/path/to/spool-plex`.

## Releasing

Current release: **0.1.8**, using the current format-3 capability contract.
The unreleased **0.1.9** profile-session branch retains separate Home/member/PMS
credentials, reuses a household link for additional watching profiles, keeps credentials
out of the login UI, distinguishes expired sign-in from wrong PIN, and bounds server
probes while preserving approved-origin and resource identity restrictions.

Bump `version` in `manifest.json` when needed, push `main`, then push the matching `v<version>` tag.
The workflow verifies pinned SDK hashes, runs the contract in Qt JIT and interpreter modes,
builds and validates the package, and attaches it with `spool-provider.json` and provenance to a
GitHub release. For the current manifest:

```sh
git push -u origin main
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
git tag "v$VERSION"
git push origin "v$VERSION"
```

The optional `STORE_DISPATCH_TOKEN` secret asks `spool-providers` to refresh immediately; otherwise
the store discovers the release on its normal schedule. An equivalent local feed-entry command is:

```sh
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
python3 sdk/spool-provider.py feed "dist/spool.plex-$VERSION.tar.zst" \
  --url "https://github.com/spool-player/spool-plex/releases/download/v$VERSION/spool.plex-$VERSION.tar.zst"
```

MPL-2.0; see LICENSE and NOTICE.

## Service icon

Plex and the Plex Play logo are trademarks of Plex and used under a license. See https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/. The icon identifies the connected service; this is an independent Spool integration, not an official Plex client. See [asset attribution](assets/BRANDING.md).
