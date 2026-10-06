// SPDX-License-Identifier: MPL-2.0
// Outbound Companion only. Never feeds inbound Events.remote or local reporting.
import { parseXml } from './xml.mjs';
import { container, item, milliseconds, ticks, trickplay } from './items.mjs';
import { createRemoteQueues } from './remote-queue.mjs';
const dependencies = ['spool.remote-targets', 'spool.http-metadata', 'spool.origin-grants'];
const navigation = { moveUp: 'Up', moveDown: 'Down', moveLeft: 'Left', moveRight: 'Right', select: 'Select',
    back: 'Back', home: 'Home', contextMenu: 'Context menu', music: 'Now playing music' };
function text(value) { return value === undefined || value === null ? '' : String(value); }
function words(value) { return text(value).split(',').map(word => word.trim()).filter(Boolean); }
function integer(value, minimum, maximum) {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}
function origin(uri) {
    const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?\/?$/.exec(text(uri));
    if (!match || match[2].indexOf('..') >= 0 || match[3] && !integer(match[3], 1, 65535)) return '';
    const port = match[3] && Number(match[3]);
    return match[1] + '://' + match[2].toLowerCase() + (port && port !== (match[1] === 'https' ? 443 : 80) ? ':' + port : '');
}
function serverAddress(uri) {
    const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?\/?$/.exec(uri);
    if (!match) throw new Error('remote_play_unavailable');
    return { protocol: match[1], address: match[2].replace(/^\[|\]$/g, ''), port: Number(match[3] || (match[1] === 'https' ? 443 : 80)) };
}
function suffix(parameters) {
    return Object.keys(parameters).filter(key => parameters[key] !== undefined && parameters[key] !== null)
        .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(parameters[key]))).join('&');
}
export function createRemote(options) {
    const host = options.host;
    const device = host.device || {};
    // Per-source controller identity prevents acknowledgements from a previous
    // attachment/process being mistaken for this controller's commands.
    const controller = 'spool-' + Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000)
        .toString(16).padStart(8, '0')).join('');
    let commandId = 0;
    let epoch = 0;
    let discovering = 0;
    let targets = new Map();
    const unavailablePlayers = new Set();
    const verifiedCapabilities = new Map();
    let attached = null;
    let pollSerial = 0;
    let acceptedPoll = 0;
    const queues = createRemoteQueues({ server: options.server });
    function guard() {
        if (dependencies.some(id => options.extensions[id] !== 1)) throw new Error('unsupported_extension');
    }
    function current(peer, ticket) {
        if (attached !== peer || ticket !== epoch) throw new Error('remote_target_changed');
    }
    function selected(id) {
        guard();
        if (!attached || attached.id !== id) throw new Error('remote_not_connected');
        return attached;
    }
    function pms(operationHost, peer, ticket) {
        return (method, path, parameters) => {
            current(peer, ticket);
            return options.request(operationHost, method, path, parameters).then(result => {
                current(peer, ticket);
                return result;
            });
        };
    }
    function peerRequest(operationHost, peer, ticket, path, parameters, data) {
        current(peer, ticket);
        if (++commandId > Number.MAX_SAFE_INTEGER) throw new Error('remote_sequence_exhausted');
        const command = commandId;
        const query = suffix(Object.assign({}, parameters || {}, { commandID: command }));
        const url = peer.origin + path + '?' + query;
        if (url.length > 8192) throw new Error('remote_request_limit');
        // No account token, Home token, PMS token, or cloud resource accessToken
        // ever goes into these headers. playMedia alone carries delegation.
        return operationHost.http(url, { headers: { Accept: 'application/xml',
            'X-Plex-Client-Identifier': controller, 'X-Plex-Device-Name': text(device.name || 'Spool'),
            'X-Plex-Product': 'Spool', 'X-Plex-Target-Client-Identifier': peer.id },
        responseHeaders: ['X-Plex-Client-Identifier'] }).then(response => {
            current(peer, ticket);
            if (response.status === 401 || response.status === 403) throw new Error('target_unauthorized');
            if (response.status < 200 || response.status >= 300) throw new Error('target_http_' + response.status);
            const identity = text((response.headers || {})['x-plex-client-identifier']);
            if (identity && identity !== peer.id || path === '/player/timeline/poll' && identity !== peer.id)
                throw new Error('target_identity_mismatch');
            // Successful commands may legitimately contain an empty body or OK.
            return data ? parseXml(response.body) : {};
        });
    }
    function allows(peer, command) { return peer.capabilities.indexOf(command) >= 0; }
    function disablePlay(peer) {
        peer.playUnavailable = true;
        unavailablePlayers.add(peer.id);
        if (host.emit) host.emit('remoteChanged', { targetId: peer.id });
    }
    function ownMedia(peer) { return peer.timeline && peer.timeline.machineIdentifier === options.serverId; }
    function queueId(peer) {
        if (!ownMedia(peer)) return '';
        const id = text(peer.timeline.playQueueID);
        return /^\d+$/.test(id) ? id : '';
    }
    function commands(peer) {
        const control = words(peer.timeline && peer.timeline.controllable);
        const result = [];
        if (allows(peer, 'playback')) {
            if (!peer.playUnavailable) result.push('play');
            const mapping = { pause: 'pause', unpause: 'play', stop: 'stop', next: 'skipNext', previous: 'skipPrevious',
                seek: 'seekTo', volume: 'volume', repeat: 'repeat', shuffle: 'shuffle' };
            Object.keys(mapping).forEach(action => {
                if (control.indexOf(mapping[action]) >= 0 || (action === 'pause' || action === 'unpause')
                        && control.indexOf('playPause') >= 0) result.push(action);
            });
            // Plex's standard Companion API has no documented mute operation.
            // In particular, volume=0 is not equivalent to a reversible mute.
            if (ownMedia(peer) && peer.raw) {
                if (control.indexOf('audioStream') >= 0) result.push('audioTrack');
                if (control.indexOf('subtitleStream') >= 0) result.push('subtitleTrack');
            }
            if (queueId(peer)) {
                if (allows(peer, 'playqueues')) result.push('queueRemove', 'queueMove');
                // Companion skipTo is key-based, even on queue-aware peers.
                // Never select an arbitrary occurrence of duplicated metadata.
                if ((control.indexOf('skipTo') >= 0 || allows(peer, 'playqueues')) && peer.queue
                        && new Set(peer.queue.rows.map(row => row.itemId)).size === peer.queue.rows.length)
                    result.push('queuePlay');
            }
        }
        return result;
    }
    function tracks(peer, streamType) {
        if (!peer.raw) return [];
        const timeline = peer.timeline;
        const media = (peer.raw.Media || []).find(raw => text(raw.id) === text(timeline.mediaId))
            || (peer.raw.Media || [])[integer(timeline.mediaIndex, 0, 10000) || 0];
        const part = media && ((media.Part || []).find(raw => text(raw.id) === text(timeline.partID || timeline.partId))
            || (media.Part || [])[integer(timeline.partIndex, 0, 10000) || 0]);
        const selectedId = text(streamType === 2 ? timeline.audioStreamID || timeline.audioStreamId
            : timeline.subtitleStreamID || timeline.subtitleStreamId);
        return ((part || {}).Stream || []).filter(raw => Number(raw.streamType) === streamType && /^\d+$/.test(text(raw.id)))
            .slice(0, 128).map(raw => ({ id: text(raw.id), label: raw.extendedDisplayTitle || raw.displayTitle || raw.title
                || raw.language || text(raw.id), selected: selectedId ? selectedId === text(raw.id) : Boolean(Number(raw.selected)) }));
    }
    function preview(peer) {
        const timeline = peer.timeline;
        if (timeline.type !== 'video')
            return undefined;
        const sources = peer.raw.Media || [];
        const mediaIndex = integer(timeline.mediaIndex, 0, 10000);
        const media = text(timeline.mediaId) ? sources.find(raw => text(raw.id) === text(timeline.mediaId))
            : mediaIndex !== undefined ? sources[mediaIndex] : sources.length === 1 ? sources[0] : undefined;
        const parts = media && media.Part || [];
        // A whole-item timestamp cannot address a later multipart BIF without
        // a documented part offset. Do not show a different part's images.
        if (parts.length !== 1)
            return undefined;
        const part = parts[0];
        const partId = text(timeline.partID || timeline.partId);
        const partIndex = integer(timeline.partIndex, 0, 10000);
        if (partId && text(part.id) !== partId || partIndex !== undefined && partIndex !== 0)
            return undefined;
        return trickplay(part, options.server(), { 'X-Plex-Token': options.token });
    }
    function state(peer) {
        const raw = peer.timeline || {};
        const result = { state: ['playing', 'paused', 'buffering', 'error'].indexOf(raw.state) >= 0 ? raw.state : 'stopped',
            commands: commands(peer) };
        if (peer.ack !== undefined) result.commandSequence = peer.ack;
        if (raw.time !== undefined && ticks(raw.time) !== undefined) result.positionTicks = ticks(raw.time);
        if (raw.duration !== undefined && ticks(raw.duration) !== undefined) result.runtimeTicks = ticks(raw.duration);
        const volume = integer(raw.volume, 0, 100);
        if (volume !== undefined) result.volume = volume;
        if (raw.mute === '0' || raw.mute === '1') result.muted = raw.mute === '1';
        if (raw.shuffle === '0' || raw.shuffle === '1') result.shuffled = raw.shuffle === '1';
        if (['0', '1', '2'].indexOf(raw.repeat) >= 0) result.repeatMode = ['RepeatNone', 'RepeatOne', 'RepeatAll'][Number(raw.repeat)];
        if (ownMedia(peer)) {
            if (peer.raw) {
                result.item = item(peer.raw);
                result.audioTracks = tracks(peer, 2);
                result.subtitleTracks = tracks(peer, 3);
                result.preview = peer.videoPreviews ? preview(peer) : undefined;
            }
            if (queueId(peer) && raw.playQueueVersion !== undefined)
                result.queueRevision = queueId(peer) + ':' + raw.playQueueVersion;
            if (/^\d+$/.test(text(raw.playQueueItemID))) result.currentEntryId = text(raw.playQueueItemID);
        }
        return result;
    }
    function poll(operationHost, peer, ticket) {
        const serial = ++pollSerial;
        return peerRequest(operationHost, peer, ticket, '/player/timeline/poll', { wait: 0 }, true).then(xml => {
            if (xml.name !== 'MediaContainer') throw new Error('invalid_timeline');
            if (xml.attributes.disconnected === '1') throw new Error('target_disconnected');
            const candidates = xml.children.filter(node => node.name === 'Timeline'
                && ['video', 'music'].indexOf(node.attributes.type) >= 0);
            const timeline = (candidates.find(node => node.attributes.state !== 'stopped') || candidates[0] || {}).attributes || {};
            const ack = integer(xml.attributes.commandID, 0, commandId);
            if (serial < acceptedPoll || ack !== undefined && peer.ack !== undefined && ack < peer.ack) return state(peer);
            const key = timeline.machineIdentifier === options.serverId && /^\d+$/.test(text(timeline.ratingKey))
                ? text(timeline.ratingKey) : '';
            const fetch = !key || peer.raw && text(peer.raw.ratingKey) === key ? Promise.resolve(key ? peer.raw : null)
                : pms(operationHost, peer, ticket)('GET', '/library/metadata/' + key).then(answer =>
                    (container(answer).Metadata || []).find(raw => text(raw.ratingKey) === key) || null).catch(() => {
                    current(peer, ticket);
                    // Metadata permission/offline failure does not disable the
                    // peer's independently authenticated transport controls.
                    return null;
                });
            return fetch.then(raw => {
                current(peer, ticket);
                if (serial < acceptedPoll || ack !== undefined && peer.ack !== undefined && ack < peer.ack) return state(peer);
                acceptedPoll = serial;
                if (text(timeline.playQueueID) !== text(peer.timeline && peer.timeline.playQueueID)
                        || text(timeline.playQueueVersion) !== text(peer.timeline && peer.timeline.playQueueVersion)
                        || timeline.machineIdentifier !== options.serverId) peer.queue = null;
                peer.timeline = timeline;
                peer.textField = text(xml.attributes.textFieldFocused);
                peer.textSecure = xml.attributes.textFieldSecure === '1';
                peer.raw = raw;
                peer.ack = ack;
                return state(peer);
            });
        });
    }
    function targetRow(peer) {
        return { id: peer.id, name: peer.name, detail: peer.detail, origins: peer.origins,
            commands: peer.capabilities.indexOf('playback') >= 0 && !unavailablePlayers.has(peer.id) ? ['play'] : [],
            queueEditing: peer.capabilities.indexOf('playqueues') >= 0 ? 'in-place' : 'none',
            customControls: peer.capabilities.indexOf('navigation') >= 0 || peer.capabilities.indexOf('mirror') >= 0 };
    }
    function refresh(args, operationHost) {
        guard();
        const serial = ++discovering;
        const local = options.request(operationHost, 'GET', '/clients').then(answer => {
            const box = container(answer);
            return box.Server || box.Player || [];
        });
        // Old PMS-only accounts deliberately do not impersonate a full/Home user.
        const cloud = options.activeAccountToken ? options.tv(operationHost, 'GET', '/api/v2/resources',
            { includeHttps: 1, includeRelay: 0 }, options.activeAccountToken).then(answer =>
                (Array.isArray(answer) ? answer : []).filter(row => words(row.provides).indexOf('player') >= 0)) : Promise.resolve([]);
        let localError = null;
        let cloudError = null;
        return Promise.all([local.catch(error => { localError = error; return []; }),
            cloud.catch(error => { cloudError = error; return []; })]).then(answers => {
            if (localError && (!options.activeAccountToken || cloudError)) throw localError;
            const found = new Map();
            answers[0].concat(answers[1]).forEach(raw => {
                const id = text(raw.clientIdentifier || raw.machineIdentifier);
                if (!id || id === text(device.id) || id === controller) return;
                const advertised = (raw.connections || []).filter(connection => !connection.relay).map(connection => origin(connection.uri));
                if (raw.address && raw.port) {
                    const address = text(raw.address);
                    advertised.push(origin((raw.protocol === 'https' ? 'https' : 'http') + '://'
                        + (address.indexOf(':') >= 0 && address[0] !== '[' ? '[' + address + ']' : address) + ':' + raw.port));
                }
                const previous = found.get(id);
                if (!previous && found.size >= 128) return;
                const origins = Array.from(new Set((previous ? previous.origins : []).concat(advertised).filter(Boolean)))
                    .sort((a, b) => Number(b.indexOf('https:') === 0) - Number(a.indexOf('https:') === 0));
                if (!origins.length) return;
                const verified = verifiedCapabilities.get(id);
                const caps = verified && verified.origin === origins[0] ? verified.capabilities
                    : Array.from(new Set((previous ? previous.capabilities : []).concat(words(raw.protocolCapabilities))));
                found.set(id, { id: id, name: text(raw.name || raw.title || previous && previous.name || id),
                    detail: text(raw.product || raw.platform || ''), origins: origins, capabilities: caps });
            });
            if (serial === discovering) targets = found;
            return { targets: Array.from(found.values()).map(targetRow) };
        });
    }
    function connect(args, operationHost) {
        guard();
        const known = targets.get(args.targetId);
        if (!known) throw new Error('target_not_found');
        const ticket = ++epoch;
        const peer = Object.assign({}, known, { origin: known.origins[0], timeline: {}, raw: null, queue: null,
            busy: false, pageSerial: 0, playUnavailable: unavailablePlayers.has(known.id), videoPreviews: args.videoPreviews === true });
        attached = peer;
        acceptedPoll = ++pollSerial;
        // Host consent is for this exact first origin only; never downgrade or
        // silently try another discovered address after denial/failure.
        return peerRequest(operationHost, peer, ticket, '/resources', {}, true).then(xml => {
            if (xml.name !== 'MediaContainer') throw new Error('target_identity_mismatch');
            const player = xml.children.find(node => node.name === 'Player' && node.attributes.machineIdentifier === peer.id);
            if (!player) throw new Error('target_identity_mismatch');
            peer.capabilities = words(player.attributes.protocolCapabilities);
            if (!allows(peer, 'timeline')) throw new Error('remote_control_unavailable');
            verifiedCapabilities.set(peer.id, { origin: peer.origin, capabilities: peer.capabilities });
            return poll(operationHost, peer, ticket);
        }).catch(error => {
            if (attached === peer && epoch === ticket) { attached = null; ++epoch; }
            throw error;
        });
    }
    function loadQueue(operationHost, peer, ticket) {
        const id = queueId(peer);
        if (!id) throw new Error('remote_queue_unavailable');
        return queues.read(pms(operationHost, peer, ticket), id, false).then(queue => {
            current(peer, ticket);
            peer.queue = queue;
            return queue;
        });
    }
    function queuePage(args, operationHost) {
        const peer = selected(args.targetId);
        const ticket = epoch;
        const limit = integer(args.limit === undefined ? 72 : args.limit, 1, 100);
        if (limit === undefined) throw new Error('invalid_page');
        let offset = 0;
        if (args.cursor !== undefined && args.cursor !== null && args.cursor !== '') {
            const match = /^([0-9]+\.[0-9]+):([0-9]+)$/.exec(text(args.cursor));
            if (!match || !peer.queue || peer.queue.cursor !== match[1]) throw new Error('invalid_cursor');
            offset = integer(match[2], 0, peer.queue.rows.length);
            if (offset === undefined) throw new Error('invalid_cursor');
        }
        const prepare = offset ? Promise.resolve(peer.queue) : loadQueue(operationHost, peer, ticket).then(queue => {
            queue.cursor = ticket + '.' + (++peer.pageSerial);
            return queue;
        });
        return prepare.then(queue => {
            const rows = queue.rows.slice(offset, offset + limit).map(row => Object.assign(item(row.raw), { entryId: row.id }));
            const exhausted = offset + rows.length >= queue.rows.length;
            return { items: rows, cursor: exhausted ? null : queue.cursor + ':' + (offset + rows.length), exhausted: exhausted };
        });
    }
    function delegation(operationHost, peer, ticket) {
        return pms(operationHost, peer, ticket)('GET', '/security/token', { type: 'delegation', scope: 'all' }).then(answer => {
            const token = text(container(answer).token);
            if (!token || token === options.token || token === options.activeAccountToken || token === options.linkedAccountToken)
                throw new Error('remote_play_unavailable');
            return token;
        }).catch(error => {
            current(peer, ticket);
            if (error.message === 'remote_play_unavailable' || /^http_(400|401|403|404|405|501)$/.test(error.message))
                disablePlay(peer);
            throw new Error('remote_play_unavailable');
        });
    }
    function playMedia(operationHost, peer, ticket, queue, index, position, variant, delegated) {
        const row = queue.rows[index];
        if (!row) throw new Error('invalid_queue_index');
        const raw = row.raw;
        const mediaIndex = variant === undefined || variant === '' ? undefined
            : (raw.Media || []).findIndex(media => text(media.id) === variant);
        if (mediaIndex === -1) throw new Error('invalid_variant');
        const parameters = Object.assign(serverAddress(options.server()), { machineIdentifier: options.serverId,
            key: '/library/metadata/' + row.itemId, offset: position, mediaIndex: mediaIndex,
            type: raw.type === 'track' ? 'music' : 'video', token: delegated,
            containerKey: '/playQueues/' + queue.id + '?window=100&own=1' });
        return peerRequest(operationHost, peer, ticket, '/player/playback/playMedia', parameters, false).then(() => {
            peer.queue = queue;
            return {};
        }).catch(error => {
            if (/^target_http_(404|405|501)$/.test(error.message)) {
                disablePlay(peer);
                throw new Error('remote_play_unavailable');
            }
            throw error;
        });
    }
    function play(args, operationHost, peer, ticket) {
        const ids = args.itemIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id))
                || !Number.isInteger(args.index) || args.index < 0 || args.index >= ids.length
                || ['now', 'next', 'last', 'shuffle'].indexOf(args.mode) < 0) throw new Error('invalid_remote_play');
        if (typeof args.positionTicks !== 'string') throw new Error('invalid_position');
        if (args.variantId !== undefined && typeof args.variantId !== 'string') throw new Error('invalid_variant');
        const position = milliseconds(args.positionTicks);
        const request = pms(operationHost, peer, ticket);
        const enqueue = args.mode === 'next' || args.mode === 'last';
        if (enqueue && (!allows(peer, 'playqueues') || !queueId(peer))) throw new Error('remote_queue_unavailable');
        if (!enqueue && args.mode !== 'shuffle' && ids.indexOf(ids[args.index]) !== args.index)
            throw new Error('remote_queue_ambiguous');
        return queues.metadata(request, ids).then(raws => {
            const types = new Set(ids.map(id => raws.get(id).type === 'track' ? 'audio'
                : ['movie', 'episode', 'clip'].indexOf(raws.get(id).type) >= 0 ? 'video' : 'unsupported'));
            if (types.size !== 1 || types.has('unsupported')) throw new Error('remote_play_unavailable');
            const type = Array.from(types)[0];
            if (args.variantId && !(raws.get(ids[args.index]).Media || []).some(media => text(media.id) === args.variantId))
                throw new Error('invalid_variant');
            if (enqueue) {
                if (type !== (peer.timeline.type === 'music' ? 'audio' : 'video')) throw new Error('remote_queue_unavailable');
                return loadQueue(operationHost, peer, ticket).then(previous => {
                    const currentIndex = previous.rows.findIndex(row => row.id === text(peer.timeline.playQueueItemID));
                    if (args.mode === 'next' && currentIndex < 0) throw new Error('remote_queue_changed');
                    return queues.append(request, previous, ids.map(id => ({ itemId: id })), false).then(queue => {
                        if (args.mode !== 'next') return queue;
                        const extra = queue.rows.slice(previous.rows.length);
                        const expected = previous.rows.slice();
                        expected.splice(currentIndex + 1, 0, ...extra);
                        return queues.order(request, queue, expected, false, 0);
                    });
                }).then(queue => refreshQueue(operationHost, peer, ticket, queue));
            }
            // Acquire delegation before creating the queue: unsupported PMS
            // delegation leaves local playback and server queue state untouched.
            const ordered = ids.slice();
            if (args.mode === 'shuffle') {
                ordered.unshift(ordered.splice(args.index, 1)[0]);
                for (let i = ordered.length - 1; i > 1; --i) {
                    const at = 1 + Math.floor(Math.random() * i);
                    const value = ordered[i]; ordered[i] = ordered[at]; ordered[at] = value;
                }
            }
            return delegation(operationHost, peer, ticket).then(token => queues.create(request, ordered, type)
                .then(queue => {
                    queue.rows.forEach(row => { row.raw = raws.get(row.itemId); });
                    return playMedia(operationHost, peer, ticket, queue, args.mode === 'shuffle' ? 0 : args.index,
                        position, args.variantId, token);
                }));
        });
    }
    function refreshQueue(operationHost, peer, ticket, queue) {
        if (!allows(peer, 'playqueues')) throw new Error('remote_queue_unavailable');
        peer.queue = queue;
        return peerRequest(operationHost, peer, ticket, '/player/playback/refreshPlayQueue',
            { playQueueID: queue.id, type: peer.timeline.type === 'music' ? 'music' : 'video' }, false);
    }
    function queueCommand(args, operationHost, peer, ticket) {
        if (typeof args.entryId !== 'string' || !/^\d+$/.test(args.entryId)) throw new Error('invalid_entry');
        const request = pms(operationHost, peer, ticket);
        return loadQueue(operationHost, peer, ticket).then(queue => {
            const index = queue.rows.findIndex(row => row.id === args.entryId);
            if (index < 0) throw new Error('entry_not_found');
            if (args.action === 'queuePlay') {
                if (new Set(queue.rows.map(row => row.itemId)).size !== queue.rows.length)
                    throw new Error('remote_queue_ambiguous');
                return peerRequest(operationHost, peer, ticket, '/player/playback/skipTo',
                    { key: '/library/metadata/' + queue.rows[index].itemId, type: peer.timeline.type }, false);
            }
            if (!allows(peer, 'playqueues')) throw new Error('remote_queue_unavailable');
            const mutation = args.action === 'queueRemove' ? queues.remove(request, queue, args.entryId)
                : queues.move(request, queue, args.entryId, args.index, args.afterEntryId, false);
            return mutation.then(fresh => refreshQueue(operationHost, peer, ticket, fresh));
        });
    }
    function command(args, operationHost) {
        const peer = selected(args.targetId);
        const ticket = epoch;
        const action = args.command || {};
        if (commands(peer).indexOf(action.action) < 0) throw new Error('unsupported_remote_command');
        if (peer.busy) throw new Error('remote_busy');
        // Fence all reads issued before this command, including metadata reads.
        acceptedPoll = ++pollSerial;
        peer.busy = true;
        return Promise.resolve().then(() => {
            if (action.action === 'play') return play(action, operationHost, peer, ticket);
            if (['queuePlay', 'queueRemove', 'queueMove'].indexOf(action.action) >= 0)
                return queueCommand(action, operationHost, peer, ticket);
            const parameters = { type: peer.timeline.type === 'music' ? 'music' : 'video' };
            let endpoint = { pause: 'pause', unpause: 'play', stop: 'stop', next: 'skipNext', previous: 'skipPrevious' }[action.action];
            if (action.action === 'seek') {
                if (typeof action.positionTicks !== 'string') throw new Error('invalid_position');
                endpoint = 'seekTo'; parameters.offset = milliseconds(action.positionTicks);
            }
            if (action.action === 'volume') {
                if (!Number.isInteger(action.value) || action.value < 0 || action.value > 100) throw new Error('invalid_volume');
                endpoint = 'setParameters'; parameters.volume = action.value;
            }
            if (action.action === 'repeat') {
                const modes = { RepeatNone: 0, RepeatOne: 1, RepeatAll: 2 };
                if (!Object.prototype.hasOwnProperty.call(modes, action.mode)) throw new Error('invalid_repeat');
                endpoint = 'setParameters'; parameters.repeat = modes[action.mode];
            }
            if (action.action === 'shuffle') {
                if (typeof action.value !== 'boolean') throw new Error('invalid_shuffle');
                endpoint = 'setParameters'; parameters.shuffle = action.value ? 1 : 0;
            }
            if (action.action === 'audioTrack' || action.action === 'subtitleTrack') {
                const subtitle = action.action === 'subtitleTrack';
                if (!(subtitle && action.trackId === null) && !tracks(peer, subtitle ? 3 : 2).some(track => track.id === action.trackId))
                    throw new Error('invalid_track');
                endpoint = 'setStreams'; parameters[subtitle ? 'subtitleStreamID' : 'audioStreamID'] = action.trackId === null ? '0' : action.trackId;
            }
            if (!endpoint) throw new Error('unsupported_remote_command');
            return peerRequest(operationHost, peer, ticket, '/player/playback/' + endpoint, parameters, false);
        }).then(result => { peer.busy = false; return result; }, error => { peer.busy = false; throw error; });
    }
    function controls(args, operationHost) {
        const peer = selected(args.targetId);
        return poll(operationHost, peer, epoch).then(() => ({
            controls: allows(peer, 'navigation') ? Object.keys(navigation).map(id => ({ id: id, label: navigation[id] })) : [],
            textInput: Boolean(peer.textField) && !peer.textSecure,
            mirror: allows(peer, 'mirror') && ownMedia(peer) && Boolean(peer.raw)
        }));
    }
    function advanced(args, operationHost) {
        const peer = selected(args.targetId);
        const ticket = epoch;
        if (allows(peer, 'navigation') && Object.prototype.hasOwnProperty.call(navigation, args.control))
            return peerRequest(operationHost, peer, ticket, '/player/navigation/' + args.control, {}, false);
        if (args.control === 'text' && peer.textField && !peer.textSecure) {
            if (typeof args.text !== 'string' || args.text.length > 1024) throw new Error('invalid_remote_text');
            return peerRequest(operationHost, peer, ticket, '/player/application/setText',
                { field: peer.textField, text: args.text }, false);
        }
        if (args.control === 'mirror' && allows(peer, 'mirror') && ownMedia(peer) && peer.raw)
            return delegation(operationHost, peer, ticket).then(token => peerRequest(operationHost, peer, ticket, '/player/mirror/details',
                Object.assign(serverAddress(options.server()), { machineIdentifier: options.serverId, token: token,
                    key: '/library/metadata/' + peer.raw.ratingKey }), false));
        throw new Error('unsupported_remote_command');
    }
    return { remoteTargets: refresh, remoteConnect: connect,
        remoteState: (args, operationHost) => { const peer = selected(args.targetId);
            peer.videoPreviews = args.videoPreviews === true; return poll(operationHost, peer, epoch); },
        remoteQueue: queuePage, remoteCommand: command, remoteControls: controls, remoteControl: advanced,
        stop: () => {
            attached = null; targets.clear(); unavailablePlayers.clear(); verifiedCapabilities.clear(); ++epoch; ++discovering;
        } };
}
