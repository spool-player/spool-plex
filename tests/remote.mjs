// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
import { run as xml } from './xml.mjs';
const capabilities = { 'remoteTargets': true, 'httpMetadata': true, 'originGrants': true };
const server = 'https://pms.test:32400';
const player = 'https://player.test:32433';
function check(value, message) { if (!value) throw new Error('remote contract: ' + message); }
function fails(operation, expected) {
    return Promise.resolve().then(operation).then(() => { throw new Error('expected ' + expected); }, error =>
        check(error.message === expected, 'expected ' + expected + ', received ' + error.message));
}
function query(url) {
    const result = {};
    const parts = (url.split('?')[1] || '').split('&');
    parts.filter(Boolean).forEach(part => {
        const at = part.indexOf('=');
        result[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1));
    });
    return result;
}
function fixture(configuration, offered) {
    const calls = [];
    const granted = new Set([server, 'https://plex.tv']);
    const state = { status: 'playing', machine: 'pms', media: '10', type: 'video', entry: '1', queue: '7', version: 1,
        time: '1250', duration: '90000', controls: 'playPause,stop,seekTo,skipNext,skipPrevious,volume,repeat,shuffle,audioStream,subtitleStream,skipTo',
        capabilities: 'timeline,playback,navigation,mirror,playqueues', ack: 0, identity: 'peer', textField: 'search', mediaIndex: 0,
        fieldSecure: false, held: null, holdNext: false, unauthorized: false, denyDelegation: false, rejectBulk: false,
        loseMutation: false, uncertainAppend: false, appliedLostAppend: false, nextEntry: 10, nextQueue: 8, streams: {},
        queues: { '7': [{ id: '1', itemId: '10' }, { id: '2', itemId: '10' }, { id: '3', itemId: '11' }] } };
    const raw = id => ({ ratingKey: id, key: '/library/metadata/' + id, type: Number(id) >= 1000 ? 'track' : 'movie',
        title: 'Item ' + id, librarySectionID: 1, librarySectionUUID: 'library-uuid', duration: 90000,
        Media: [{ id: 'variant-a', Part: [{ id: 1, indexes: 'sd', Stream: [
            { id: 901, index: 1, streamType: 2, selected: 1, displayTitle: 'Audio' },
            { id: 904, index: 4, streamType: 3, selected: 1, displayTitle: 'Subtitles' }] }] },
        { id: 'variant-b', Part: [{ id: 2, indexes: 'hd', Stream: [] }] }] });
    const respond = (body, status, headers) => Promise.resolve({ status: status || 200,
        body: typeof body === 'string' ? body : JSON.stringify(body), headers: headers || {} });
    const queue = id => ({ MediaContainer: { playQueueID: id, playQueueTotalCount: state.queues[id].length,
        playQueueVersion: state.version, Metadata: state.queues[id].map(row =>
            Object.assign(raw(row.itemId), { playQueueItemID: row.id })) } });
    const timeline = () => '<MediaContainer commandID="' + state.ack + '" textFieldFocused="' + state.textField
        + '" textFieldSecure="' + (state.fieldSecure ? '1' : '0') + '"><Timeline type="' + state.type
        + '" state="' + state.status + '" machineIdentifier="' + state.machine + '" ratingKey="' + state.media
        + '" time="' + state.time + '" duration="' + state.duration + '" playQueueID="' + state.queue
        + '" playQueueVersion="' + state.version + '" playQueueItemID="' + state.entry
        + '" controllable="' + state.controls + '" mediaIndex="' + state.mediaIndex
        + '" subtitleStreamID="904" audioStreamID="901"/></MediaContainer>';
    const host = { device: { id: 'self', name: 'Spool fixture' }, capabilities: offered || capabilities, emit: () => {},
        http: (url, options) => {
            const base = /^(https?:\/\/[^/]+)/.exec(url)[1];
            const path = url.slice(base.length).split('?')[0];
            const parameters = query(url);
            const method = options.method || 'GET';
            calls.push({ base: base, path: path, query: parameters, options: options, method: method, url: url });
            if (!granted.has(base)) return Promise.reject(new Error('origin_denied'));
            if (base === 'https://plex.tv') {
                check(options.headers['X-Plex-Token'] === 'active-token', 'cloud discovery uses active identity only');
                return respond([{ clientIdentifier: 'peer', name: 'Cloud peer', provides: 'player', accessToken: 'never-send',
                    protocolCapabilities: state.advertisedCapabilities === undefined ? state.capabilities : state.advertisedCapabilities,
                    connections: [{ uri: player, local: true }] },
                { clientIdentifier: 'not-a-player', provides: 'server', connections: [{ uri: 'https://other.test' }] }]);
            }
            if (base === player || base === 'http://player.test:32433') {
                check(options.headers['X-Plex-Token'] === undefined && options.headers['X-Plex-Target-Client-Identifier'] === 'peer',
                    'peer never receives a long-lived credential and has exact identity headers');
                check(options.headers['X-Plex-Client-Identifier'] !== 'self' && options.headers['X-Plex-Device-Name'] === 'Spool fixture',
                    'source-private Companion session and device name');
                check(options.responseHeaders.indexOf('X-Plex-Client-Identifier') >= 0, 'peer identity is requested natively');
                check(Number(parameters.commandID) > 0, 'every peer request carries a command id');
                if (state.unauthorized) return respond('', 401);
                const identity = { 'x-plex-client-identifier': state.identity };
                if (path === '/resources') return respond('<MediaContainer><Player machineIdentifier="peer" protocolCapabilities="'
                    + state.capabilities + '"/></MediaContainer>', 200, identity);
                if (path === '/player/timeline/poll') {
                    check(parameters.wait === '0', 'poll never waits or opens a callback listener');
                    const body = timeline();
                    if (state.holdNext) {
                        state.holdNext = false;
                        return new Promise(resolve => { state.held = () => resolve({ status: 200, body: body, headers: identity }); });
                    }
                    return respond(body, 200, identity);
                }
                state.ack = Number(parameters.commandID);
                if (path === '/player/playback/pause') state.status = 'paused';
                else if (path === '/player/playback/play') state.status = 'playing';
                else if (path === '/player/playback/seekTo') state.time = parameters.offset;
                else if (path === '/player/playback/setStreams') Object.assign(state.streams, parameters);
                else if (path === '/player/playback/playMedia') {
                    check(parameters.token === 'delegated-token', 'playMedia uses only transient delegation');
                    check(parameters.machineIdentifier === 'pms' && parameters.protocol === 'https'
                        && parameters.address === 'pms.test' && parameters.port === '32400', 'delegated PMS address identity');
                    check(parameters.playQueueItemID === undefined, 'no invented Companion occurrence parameter');
                    state.queue = /^\/playQueues\/(\d+)\?window=100&own=1$/.exec(parameters.containerKey)[1];
                    state.media = parameters.key.split('/').pop(); state.type = parameters.type;
                    state.entry = state.queues[state.queue].find(row => row.itemId === state.media).id;
                    state.status = 'playing'; state.time = parameters.offset;
                } else if (path === '/player/playback/refreshPlayQueue') {
                    check(parameters.playQueueID === state.queue, 'refreshes only the attached queue');
                } else if (path === '/player/mirror/details') check(parameters.token === 'delegated-token', 'mirror delegates too');
                return respond('OK', 200, identity);
            }
            check(base === server && options.headers['X-Plex-Token'] === 'pms-token', 'PMS keeps its separate token');
            if (path === '/clients') return respond({ MediaContainer: { Server: [
                { machineIdentifier: 'peer', name: 'Local peer', address: 'player.test', port: 32433,
                    protocolCapabilities: state.advertisedCapabilities === undefined ? state.capabilities : state.advertisedCapabilities },
                { machineIdentifier: 'self', address: 'self.test', port: 32433, protocolCapabilities: state.capabilities }] } });
            if (path === '/security/token') return respond(state.denyDelegation ? {} : { MediaContainer: { token: 'delegated-token' } },
                state.denyDelegation ? 404 : 200);
            if (path.indexOf('/library/metadata/') === 0) {
                const ids = path.split('/').pop().split(',');
                check(ids.length <= 50, 'metadata requests stay within fifty IDs');
                return respond({ MediaContainer: { Metadata: ids.map(raw).reverse() } });
            }
            if (path === '/library/sections') return respond({ MediaContainer: { Directory: [{ key: '1', uuid: 'library-uuid' }] } });
            if (method === 'POST' && path === '/playQueues') {
                const ids = decodeURIComponent(parameters.uri.slice('library:///directory/'.length)).split('/').pop().split(',');
                check(ids.length <= 50, 'initial PMS queue is a bounded batch');
                const id = String(state.nextQueue++);
                state.queues[id] = ids.map(itemId => ({ id: String(state.nextEntry++), itemId: itemId }));
                return respond(queue(id));
            }
            const match = /^\/playQueues\/(\d+)(?:\/items\/(\d+)(\/move)?)?$/.exec(path);
            if (match) {
                const id = match[1];
                const rows = state.queues[id];
                if (method === 'GET') return respond(queue(id));
                if (method === 'DELETE') {
                    state.queues[id] = rows.filter(row => row.id !== match[2]);
                } else if (match[3]) {
                    const at = rows.findIndex(row => row.id === match[2]);
                    const row = rows.splice(at, 1)[0];
                    rows.splice(parameters.after ? rows.findIndex(entry => entry.id === parameters.after) + 1 : 0, 0, row);
                } else if (method === 'PUT') {
                    const bulk = parameters.uri.indexOf('library:///directory/') === 0;
                    if (bulk && state.rejectBulk) return respond({}, 400);
                    if (state.uncertainAppend && !state.appliedLostAppend) return Promise.reject(new Error('network_error'));
                    const ids = bulk ? decodeURIComponent(parameters.uri.slice('library:///directory/'.length)).split('/').pop().split(',')
                        : [parameters.uri.split('/').pop()];
                    check(ids.length <= 50, 'append PMS queue is a bounded batch');
                    rows.push(...ids.map(itemId => ({ id: String(state.nextEntry++), itemId: itemId })));
                }
                ++state.version;
                if (state.loseMutation || state.uncertainAppend) {
                    state.loseMutation = false;
                    return Promise.reject(new Error('network_error'));
                }
                return respond(queue(id));
            }
            return respond({}, 404);
        } };
    const source = createSource(Object.assign({ server: server, serverId: 'pms', token: 'pms-token',
        activeAccountToken: 'active-token', linkedAccountToken: 'linked-token' }, configuration || {}), host);
    return { host: host, source: source, state: state, calls: calls, granted: granted };
}
function attach(fixture) {
    return fixture.source.remoteTargets({}, fixture.host).then(() => {
        fixture.granted.add(player);
        fixture.granted.add('http://player.test:32433');
        return fixture.source.remoteConnect({ targetId: 'peer' }, fixture.host);
    });
}
export function run() {
    xml();
    const f = fixture();
    const invoke = command => f.source.remoteCommand({ targetId: 'peer', command: command }, f.host);
    const readState = () => f.source.remoteState({ targetId: 'peer', videoPreviews: true }, f.host);
    let stale;
    let firstCursor;
    return f.source.remoteTargets({}, f.host).then(result => {
        check(result.targets.length === 1 && result.targets[0].id === 'peer', 'deduplicates account targets and excludes this installation');
        check(result.targets[0].origins[0] === player && !f.calls.some(call => call.base === player), 'discovery prefers HTTPS without contacting unconsented peers');
        return fails(() => f.source.remoteConnect({ targetId: 'peer' }, f.host), 'origin_denied');
    }).then(() => {
        f.granted.add(player);
        return f.source.remoteConnect({ targetId: 'peer', videoPreviews: true }, f.host);
    }).then(snapshot => {
        check(snapshot.state === 'playing' && snapshot.positionTicks === '12500000' && snapshot.volume === undefined,
            'known milliseconds normalize while unknown volume stays absent');
        check(snapshot.audioTracks[0].id === '901' && snapshot.subtitleTracks[0].id === '904'
            && snapshot.commands.indexOf('mute') < 0, 'stream IDs, not indexes; no simulated mute');
        check(!f.calls.some(call => call.path === '/player/playback/playMedia' || call.method === 'POST'), 'selection never starts playback');
        check(snapshot.preview.format === 'bif'
            && snapshot.preview.url === server + '/library/parts/1/indexes/sd?interval=10000'
            && snapshot.preview.headers['X-Plex-Token'] === 'pms-token', 'remote BIF binds the timeline-selected part on this PMS');
        f.state.mediaIndex = 1;
        return readState();
    }).then(snapshot => {
        check(snapshot.preview.url === server + '/library/parts/2/indexes/hd?interval=10000',
            'a timeline variant change selects its own BIF without reusing the previous part');
        f.state.mediaIndex = 99;
        return readState();
    }).then(snapshot => {
        check(snapshot.preview === undefined, 'an unknown remote variant cannot borrow an index');
        f.state.mediaIndex = 0;
        return readState();
    }).then(() => {
        return invoke({ action: 'subtitleTrack', trackId: null });
    }).then(() => {
        check(f.state.streams.subtitleStreamID === '0', 'subtitle Off is native stream zero');
        return fails(() => invoke({ action: 'audioTrack', trackId: null }), 'invalid_track');
    }).then(() => invoke({ action: 'seek', positionTicks: '9007199254740993' })).then(() => {
        check(f.state.time === '900719925474', 'decimal ticks floor before Number conversion');
        return fails(() => invoke({ action: 'seek', positionTicks: '9223372036854775808' }), 'invalid_position');
    }).then(() => {
        f.state.holdNext = true;
        stale = readState();
        return invoke({ action: 'pause' });
    }).then(readState).then(snapshot => {
        check(snapshot.state === 'paused', 'new poll observes accepted pause');
        f.state.held();
        return stale;
    }).then(snapshot => {
        check(snapshot.state === 'paused', 'pre-command poll cannot overwrite newer state');
        return f.source.remoteQueue({ targetId: 'peer', limit: 1 }, f.host);
    }).then(page => {
        firstCursor = page.cursor;
        check(page.items[0].entryId === '1' && !page.exhausted, 'queue page carries exact occurrence identity');
        return f.source.remoteQueue({ targetId: 'peer', cursor: page.cursor, limit: 2 }, f.host);
    }).then(page => {
        check(page.items[0].id === '10' && page.items[0].entryId === '2' && page.exhausted, 'duplicate rows remain distinct');
        return readState();
    }).then(snapshot => {
        check(snapshot.commands.indexOf('queuePlay') < 0, 'ambiguous key-based skip is omitted even on queue-aware peers');
        f.state.loseMutation = true;
        return invoke({ action: 'queueRemove', entryId: '2' });
    }).then(() => {
        check(f.state.queues['7'].map(row => row.id).join(',') === '1,3', 'uncertain response reads back exact removal, without retrying');
        return invoke({ action: 'queueMove', entryId: '3', index: 0, afterEntryId: null });
    }).then(() => {
        check(f.state.queues['7'].map(row => row.id).join(',') === '3,1', 'post-removal index and null first anchor move correct occurrence');
        check(f.calls.filter(call => call.path === '/playQueues/7' && call.method === 'GET').every(call => call.query.own === '0'),
            'inspecting and verifying peer-owned queues never seizes ownership');
        return fails(() => invoke({ action: 'queueMove', entryId: '3', index: 1, afterEntryId: null }), 'invalid_queue_destination');
    }).then(() => {
        f.state.machine = 'foreign-pms'; f.state.media = '999';
        const count = f.calls.filter(call => call.path.indexOf('/library/metadata/') === 0).length;
        return readState().then(snapshot => {
            check(snapshot.item === undefined && snapshot.commands.indexOf('audioTrack') < 0
                && snapshot.commands.indexOf('queueMove') < 0 && snapshot.commands.indexOf('pause') >= 0,
                'foreign PMS item omits metadata/edit actions but retains transport');
            check(count === f.calls.filter(call => call.path.indexOf('/library/metadata/') === 0).length,
                'foreign rating key is never resolved on this account server');
        });
    }).then(() => {
        f.state.machine = 'pms'; f.state.media = '10';
        return readState();
    }).then(() => f.source.remoteControls({ targetId: 'peer' }, f.host)).then(panel => {
        check(panel.textInput && panel.controls.some(control => control.id === 'moveUp') && panel.mirror, 'advanced controls follow peer capabilities/focused field');
        return f.source.remoteControl({ targetId: 'peer', control: 'text', text: 'hello & goodbye' }, f.host);
    }).then(() => {
        const call = f.calls[f.calls.length - 1];
        check(call.path === '/player/application/setText' && call.query.field === 'search' && call.query.text === 'hello & goodbye',
            'text goes to backend-advertised field with proper escaping');
        f.state.fieldSecure = true;
        return f.source.remoteControls({ targetId: 'peer' }, f.host);
    }).then(panel => {
        check(!panel.textInput, 'secure field content is never mirrored');
        return f.source.remoteConnect({ targetId: 'peer' }, f.host);
    }).then(() => f.source.remoteQueue({ targetId: 'peer', limit: 1 }, f.host)).then(() =>
        fails(() => f.source.remoteQueue({ targetId: 'peer', cursor: firstCursor }, f.host), 'invalid_cursor'))
        .then(() => {
            f.state.rejectBulk = true;
            const ids = Array.from({ length: 52 }, (_, index) => String(index + 20));
            ids.push('20');
            return invoke({ action: 'play', itemIds: ids, index: 0, positionTicks: '9007199254740993', mode: 'now', variantId: 'variant-b' });
        }).then(() => {
            const rows = f.state.queues[f.state.queue];
            check(rows.length === 53 && rows[0].itemId === '20' && rows[52].itemId === '20' && rows[0].id !== rows[52].id,
                'verified bulk creation plus single append fallback preserves order and duplicate occurrences');
            const call = f.calls.filter(value => value.path === '/player/playback/playMedia').pop();
            check(call.query.mediaIndex === '1' && call.query.offset === '900719925474' && call.query.type === 'video',
                'Companion gets variant ordinal, exact floored offset, and video type');
            return fails(() => invoke({ action: 'play', itemIds: ['10', '10'], index: 1, positionTicks: '0', mode: 'now' }), 'remote_queue_ambiguous');
        }).then(() => invoke({ action: 'play', itemIds: ['1000', '1001'], index: 0, positionTicks: '0', mode: 'now' }))
        .then(() => {
            const create = f.calls.filter(call => call.method === 'POST' && call.path === '/playQueues').pop();
            const play = f.calls.filter(call => call.path === '/player/playback/playMedia').pop();
            check(create.query.type === 'audio' && play.query.type === 'music', 'PMS audio differs from Companion music');
            f.state.identity = 'wrong-peer';
            return fails(readState, 'target_identity_mismatch');
        }).then(() => {
            f.state.identity = 'peer'; f.state.unauthorized = true;
            return fails(readState, 'target_unauthorized');
        }).then(() => {
            const old = fixture({}, { 'remoteTargets': true });
            check(!old.source.describe().capabilities['remoteTargets'], 'dependency loss withdraws optional remote extension');
            return fails(() => old.source.remoteTargets({}, old.host), 'unsupported_capability')
                .then(() => check(old.calls.length === 0, 'unsupported remote makes no HTTP request'));
        }).then(() => {
            const pmsOnly = fixture({ activeAccountToken: '', linkedAccountToken: 'linked-token' });
            return pmsOnly.source.remoteTargets({}, pmsOnly.host).then(result => {
                check(result.targets[0].id === 'peer' && pmsOnly.calls.every(call => call.base === server),
                    'PMS-only discovery never falls back to linked full account identity');
            });
        }).then(() => {
            const denied = fixture();
            denied.state.denyDelegation = true;
            return attach(denied).then(() => fails(() => denied.source.remoteCommand({ targetId: 'peer',
                command: { action: 'play', itemIds: ['10'], index: 0, positionTicks: '0', mode: 'now' } }, denied.host), 'remote_play_unavailable'))
                .then(() => {
                    check(!denied.calls.some(call => call.method === 'POST' || call.path === '/player/playback/playMedia'),
                        'unsupported delegation sends neither queue mutation nor long-lived target token');
                    return denied.source.remoteState({ targetId: 'peer' }, denied.host);
                }).then(snapshot => {
                    check(snapshot.commands.indexOf('play') < 0 && snapshot.commands.indexOf('pause') >= 0,
                        'unsupported remote play is hidden independently of transport');
                    return denied.source.remoteConnect({ targetId: 'peer' }, denied.host);
                }).then(snapshot => check(snapshot.commands.indexOf('play') < 0 && snapshot.commands.indexOf('pause') >= 0,
                    'reselecting the peer retains proven per-source remote-play limitation'));
        }).then(() => {
            const legacy = fixture();
            legacy.state.capabilities = 'timeline,playback';
            return attach(legacy).then(() => legacy.source.remoteQueue({ targetId: 'peer' }, legacy.host))
                .then(() => legacy.source.remoteState({ targetId: 'peer' }, legacy.host)).then(snapshot => {
                    check(snapshot.commands.indexOf('queueMove') < 0 && snapshot.commands.indexOf('queuePlay') < 0,
                        'legacy peers do not mutate queues or choose ambiguous duplicates');
                });
        }).then(() => {
            const unverified = fixture();
            unverified.state.advertisedCapabilities = '';
            return unverified.source.remoteTargets({}, unverified.host).then(result => {
                check(!result.targets[0].customControls && result.targets[0].queueEditing === 'none',
                    'discovery without capabilities makes no advanced-control claims');
                unverified.granted.add(player);
                return unverified.source.remoteConnect({ targetId: 'peer' }, unverified.host);
            }).then(() => unverified.source.remoteTargets({}, unverified.host)).then(result => {
                check(result.targets[0].customControls && result.targets[0].queueEditing === 'in-place',
                    'consented resource verification updates the selected descriptor on account refresh');
            });
        }).then(() => {
            const waiting = fixture();
            return attach(waiting).then(() => {
                waiting.state.holdNext = true;
                const old = fails(() => waiting.source.remoteState({ targetId: 'peer' }, waiting.host), 'remote_target_changed');
                // Enter the operation before changing the selection epoch.
                return Promise.resolve().then(() => waiting.source.remoteConnect({ targetId: 'peer' }, waiting.host)).then(() => {
                    waiting.state.held();
                    return old;
                });
            });
        }).then(() => {
            const unchanged = fixture();
            unchanged.state.uncertainAppend = true;
            return attach(unchanged).then(() => fails(() => unchanged.source.remoteCommand({ targetId: 'peer',
                command: { action: 'play', itemIds: ['12'], index: 0, positionTicks: '0', mode: 'last' } }, unchanged.host), 'network_error'))
                .then(() => {
                    check(unchanged.state.queues['7'].map(row => row.id).join(',') === '1,2,3'
                        && unchanged.calls.filter(call => call.method === 'PUT').length === 1,
                        'uncertain unapplied append fails after read-back, without blind bulk or single-item retry');
                });
        }).then(() => {
            const applied = fixture();
            applied.state.uncertainAppend = true;
            applied.state.appliedLostAppend = true;
            return attach(applied).then(() => applied.source.remoteCommand({ targetId: 'peer',
                command: { action: 'play', itemIds: ['12'], index: 0, positionTicks: '0', mode: 'last' } }, applied.host))
                .then(() => {
                    check(applied.state.queues['7'].map(row => row.itemId).join(',') === '10,10,11,12'
                        && applied.calls.filter(call => call.method === 'PUT').length === 1,
                        'applied append with lost response is acknowledged only after exact read-back, never duplicated');
                });
        }).then(() => {
            const peerCalls = f.calls.filter(call => call.base === player);
            check(peerCalls.every((call, index) => !index || Number(call.query.commandID) > Number(peerCalls[index - 1].query.commandID)),
                'one monotonic command counter spans resource reads, polls, commands, and reconnections');
        });
}
