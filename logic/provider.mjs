// SPDX-License-Identifier: MPL-2.0
// Plex for Spool: one source per Plex user and server.

import { collectionTypes, container, item, milliseconds, page, segments, stream } from './items.mjs';
import { connect } from './events.mjs';
import { playbackPlan } from './profile.mjs';

const plexTv = 'https://plex.tv';
const library = 'com.plexapp.plugins.library';

// Plex's own item type numbers, for listing one kind within a library.
const sectionTypes = { movies: 1, tvshows: 2, music: 9 };
const sorts = {
    SortName: 'titleSort', Random: 'random', CommunityRating: 'audienceRating', CriticRating: 'rating',
    DateCreated: 'addedAt', DateLastContentAdded: 'updatedAt', OfficialRating: 'contentRating',
    PremiereDate: 'originallyAvailableAt', PlayCount: 'viewCount', Runtime: 'duration', DatePlayed: 'lastViewedAt'
};
const searchTypes = ['movie', 'show', 'episode', 'artist', 'album', 'track', 'collection'];

function query(values) {
    return Object.keys(values).filter(key => values[key] !== undefined && values[key] !== null && values[key] !== '')
        .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key]))).join('&');
}

function segment(value) {
    if (typeof value !== 'string' || !value)
        throw new Error('missing_id');
    return encodeURIComponent(value);
}

function start(args) {
    const cursor = args.cursor ? String(args.cursor) : '0';
    if (!/^\d+$/.test(cursor))
        throw new Error('invalid_cursor');
    return Number(cursor);
}

function section(id) {
    const match = /^section:(\d+)$/.exec(String(id || ''));
    return match ? match[1] : '';
}

function code(error) {
    return String((error && error.message) || error);
}

export function headers(device, token) {
    const result = {
        Accept: 'application/json', 'X-Plex-Product': 'Spool', 'X-Plex-Version': String(device.version || '0'),
        'X-Plex-Client-Identifier': String(device.id || 'spool'), 'X-Plex-Platform': String(device.platform || 'Spool'),
        'X-Plex-Device-Name': String(device.name || 'Spool')
    };
    if (token)
        result['X-Plex-Token'] = token;
    return result;
}

function parse(response) {
    if (response.status < 200 || response.status >= 300)
        throw new Error('http_' + response.status);
    return response.body ? JSON.parse(response.body) : {};
}

// Prefer local addresses, then remote, then Plex's relay. Advertised local
// addresses also get an HTTP fallback when the plex.direct certificate fails.
export function connections(list) {
    const rank = c => (c.relay ? 2 : c.local ? 0 : 1);
    const sorted = (list || []).filter(c => /^https?:\/\//.test(String(c.uri || ''))).sort((a, b) => rank(a) - rank(b));
    const result = [];
    const add = (uri, local) => {
        const normalized = uri.replace(/\/+$/, '');
        if (!result.some(c => c.uri === normalized))
            result.push({ uri: normalized, local: local });
    };
    for (const c of sorted) {
        add(c.uri, Boolean(c.local) && !c.relay);
        if (c.local && !c.relay && c.address && c.port) {
            const address = c.address.indexOf(':') >= 0 && c.address[0] !== '[' ? '[' + c.address + ']' : c.address;
            add('http://' + address + ':' + c.port, true);
        }
    }
    return result;
}

export function createSource(configuration, sourceHost) {
    const device = sourceHost.device || {};
    const token = configuration.token || '';
    const serverId = configuration.serverId || '';
    const known = configuration.connections || [];
    let server = configuration.server || '';
    const sessions = {};
    let disconnect = null;

    function tv(host, method, path, parameters, userToken) {
        const suffix = query(parameters || {});
        return host.http(plexTv + path + (suffix ? '?' + suffix : ''), { method: method,
            headers: headers(device, userToken) }).then(parse);
    }

    // A server that stops answering at one address is tried at the others
    // it was signed in with, and the one that answers is remembered.
    function request(host, method, path, parameters) {
        const suffix = query(parameters || {});
        const candidates = [server].concat(known.map(c => c.uri).filter(uri => uri !== server));
        function attempt(index) {
            const base = candidates[index];
            return host.http(base + path + (suffix ? '?' + suffix : ''),
                { method: method, headers: headers(device, token) }).then(parse).then(result => {
                if (server !== base) {
                    server = base;
                    sourceHost.emit('configuration', { server: base });
                    if (disconnect)
                        disconnect();
                    disconnect = sourceHost.socket ? connect(sourceHost,
                        server.replace(/^http/i, 'ws') + '/:/websockets/notifications', headers(device, token)) : null;
                }
                return result;
            }, error => {
                if (code(error) !== 'network_error' || index + 1 >= candidates.length)
                    throw error;
                return attempt(index + 1);
            });
        }
        return attempt(0);
    }

    function list(host, path, args, parameters) {
        const first = start(args);
        const limit = Math.min(Math.max(args.limit || 72, 1), 100);
        return request(host, 'GET', path, Object.assign({ includeGuids: 1 }, parameters || {},
            { 'X-Plex-Container-Start': first, 'X-Plex-Container-Size': limit }))
            .then(result => page(result, first, limit));
    }

    function all(host, path, parameters) {
        return request(host, 'GET', path, parameters).then(result => page(result, 0, Number.MAX_SAFE_INTEGER));
    }

    const metadata = id => '/library/metadata/' + segment(id);
    const uri = id => 'server://' + serverId + '/' + library + '/library/metadata/' + id;

    // Genres filter by tag id, which is per library.
    const genreIds = {};
    function genreId(host, key, name) {
        const cached = genreIds[key] ? Promise.resolve(genreIds[key])
            : request(host, 'GET', '/library/sections/' + key + '/genre').then(result => {
                genreIds[key] = container(result).Directory || [];
                return genreIds[key];
            });
        return cached.then(genres => {
            const found = genres.find(g => String(g.title).toLowerCase() === String(name).toLowerCase());
            return found ? found.key : undefined;
        });
    }

    function sectionParameters(host, key, args) {
        const filters = args.filters || {};
        const status = filters.filters || [];
        const parameters = {
            type: sectionTypes[args.collectionType],
            sort: (sorts[args.sortBy] || 'titleSort') + (args.sortOrder === 'Descending' ? ':desc' : ''),
            studio: args.studio, year: (filters.years || []).join(','),
            contentRating: (filters.officialRatings || []).join(','),
            unwatched: status.indexOf('IsUnplayed') >= 0 ? 1 : status.indexOf('IsPlayed') >= 0 ? 0 : undefined,
            inProgress: status.indexOf('IsResumable') >= 0 ? 1 : undefined
        };
        const genres = (filters.genres || []).concat(args.genre ? [args.genre] : []);
        if (genres.length === 0)
            return Promise.resolve(parameters);
        return Promise.all(genres.map(name => genreId(host, key, name))).then(ids => {
            // A genre this library does not have matches nothing in it.
            parameters.genre = ids.every(Boolean) ? ids.join(',') : '-1';
            return parameters;
        });
    }

    if (server && token && sourceHost.socket)
        disconnect = connect(sourceHost, server.replace(/^http/i, 'ws') + '/:/websockets/notifications',
            headers(device, token));

    return {
        describe: () => ({
            artwork: server + '/photo/:/transcode?width={width}&height=4320&minSize=0&upscale=0&url={tag}&X-Plex-Token='
                + encodeURIComponent(token)
        }),

        // Sign-in: a code linked at plex.tv/link, then one of the account's
        // servers. These run before the account exists.
        pinStart: (args, host) => tv(host, 'POST', '/api/v2/pins', { strong: false })
            .then(pin => ({ id: String(pin.id), code: pin.code })),
        pinPoll: (args, host) => tv(host, 'GET', '/api/v2/pins/' + segment(String(args.id || ''))).then(pin => {
            if (!pin.authToken)
                return { pending: true };
            return Promise.all([tv(host, 'GET', '/api/v2/user', {}, pin.authToken),
                tv(host, 'GET', '/api/v2/resources', { includeHttps: 1, includeRelay: 1 }, pin.authToken)])
                .then(([user, resources]) => ({
                    user: { id: String(user.id), name: user.title || user.username || '' },
                    servers: (Array.isArray(resources) ? resources : [])
                        .filter(r => String(r.provides || '').split(',').indexOf('server') >= 0)
                        .map(r => ({ id: r.clientIdentifier, name: r.name || '', token: r.accessToken || pin.authToken,
                            connections: connections(r.connections) }))
                }));
        }),
        // The authenticated root both verifies the token and checks that an
        // advertised address still belongs to the selected server.
        connect: (args, host) => {
            const target = args.server || {};
            const user = args.user || {};
            const candidates = target.connections || [];
            const reachable = c => Promise.race([
                host.http(c.uri + '/', { headers: headers(device, target.token) }).then(parse)
                    .then(result => container(result).machineIdentifier === target.id, () => false),
                host.delay(4000).then(() => false)
            ]);
            return Promise.all(candidates.map(reachable)).then(answers => {
                const chosen = candidates[answers.indexOf(true)];
                if (!chosen)
                    throw new Error('server_unreachable');
                return {
                    account: user.id + '@' + target.id, group: target.id, label: user.name || '', detail: target.name || '',
                    configuration: { server: chosen.uri, connections: candidates, token: target.token,
                        serverId: target.id, serverName: target.name || '', userId: user.id, userName: user.name || '' }
                };
            });
        },

        libraries: (args, host) => request(host, 'GET', '/library/sections').then(result => ({
            items: (container(result).Directory || []).map(d => ({ id: 'section:' + d.key, title: d.title || '',
                collectionType: collectionTypes[d.type] || '' }))
        })),
        browse: (args, host) => {
            const key = section(args.parentId);
            if (args.parentId && !key)
                return list(host, metadata(args.parentId) + '/children', args);
            if (key)
                return sectionParameters(host, key, args)
                    .then(parameters => list(host, '/library/sections/' + key + '/all', args, parameters));
            // Continue across section boundaries instead of dropping every item
            // after the first page of each library.
            const match = /^(\d+):(\d+)$/.exec(String(args.cursor || '0:0'));
            if (!match)
                throw new Error('invalid_cursor');
            return request(host, 'GET', '/library/sections').then(result => {
                const wanted = (container(result).Directory || [])
                    .filter(d => !args.collectionType || collectionTypes[d.type] === args.collectionType);
                const limit = Math.min(Math.max(args.limit || 72, 1), 100);
                const rows = [];
                function collect(index, offset) {
                    if (index >= wanted.length)
                        return { items: rows, cursor: null, exhausted: true };
                    return sectionParameters(host, String(wanted[index].key), args).then(parameters =>
                        list(host, '/library/sections/' + wanted[index].key + '/all',
                            { cursor: String(offset), limit: limit - rows.length }, parameters)).then(p => {
                        rows.push(...p.items);
                        const nextIndex = p.exhausted ? index + 1 : index;
                        const nextOffset = p.exhausted ? 0 : Number(p.cursor);
                        if (rows.length >= limit)
                            return { items: rows, cursor: nextIndex < wanted.length ? nextIndex + ':' + nextOffset : null,
                                exhausted: nextIndex >= wanted.length };
                        return collect(nextIndex, nextOffset);
                    });
                }
                return collect(Number(match[1]), Number(match[2]));
            });
        },
        items: (args, host) => (args.ids || []).length === 0 ? { items: [], cursor: null, exhausted: true }
            : all(host, '/library/metadata/' + args.ids.map(id => segment(String(id))).join(',')),
        search: (args, host) => {
            const limit = Math.min(Math.max(args.limit || 40, 1), 100);
            return request(host, 'GET', '/hubs/search', { query: args.query, limit: limit, includeCollections: 1 })
                .then(result => {
                    const rows = [];
                    for (const hub of container(result).Hub || []) {
                        if (searchTypes.indexOf(hub.type) >= 0)
                            rows.push(...(hub.Metadata || []));
                    }
                    return { items: rows.slice(0, limit).map(item), cursor: null, exhausted: true };
                });
        },
        details: (args, host) => request(host, 'GET', metadata(args.itemId), { includeMarkers: 1, includeGuids: 1 })
            .then(result => {
                const raw = (container(result).Metadata || [])[0];
                if (!raw)
                    throw new Error('http_404');
                return { item: item(raw) };
            }),
        seasons: (args, host) => list(host, metadata(args.seriesId) + '/children', args),
        episodes: (args, host) => args.seasonId ? list(host, metadata(args.seasonId) + '/children', args)
            : list(host, metadata(args.seriesId) + '/allLeaves', args),
        // On Deck holds both what is half watched and what comes next.
        resume: (args, host) => all(host, '/library/onDeck').then(p => ({ items: p.items.filter(i => Number(i.resumeTicks) > 0),
            cursor: null, exhausted: true })),
        nextUp: (args, host) => all(host, '/library/onDeck').then(p => ({
            items: p.items.filter(i => i.type === 'Episode' && !(Number(i.resumeTicks) > 0)), cursor: null, exhausted: true
        })),
        latest: (args, host) => {
            const key = section(args.parentId);
            return list(host, key ? '/library/sections/' + key + '/recentlyAdded' : '/library/recentlyAdded', args);
        },
        similar: (args, host) => list(host, metadata(args.itemId) + '/similar', args),
        personItems: (args, host) => {
            const match = /^(\d+)\/(actor|director|writer)\/(\d+)$/.exec(String(args.personId || ''));
            if (!match)
                throw new Error('missing_id');
            return list(host, '/library/sections/' + match[1] + '/all', args,
                { [match[2]]: match[3], sort: 'originallyAvailableAt:desc' });
        },
        filterOptions: (args, host) => {
            const key = section(args.parentId);
            if (!key)
                return {};
            const titles = path => request(host, 'GET', '/library/sections/' + key + path)
                .then(result => (container(result).Directory || []).map(d => String(d.title)), () => []);
            return Promise.all([titles('/genre'), titles('/year'), titles('/contentRating')])
                .then(([genres, years, ratings]) => ({ genres: genres, years: years.map(Number).filter(Number.isInteger),
                    officialRatings: ratings }));
        },

        resolve: (args, host) => request(host, 'GET', metadata(args.itemId), { includeMarkers: 1 }).then(result => {
            const raw = (container(result).Metadata || [])[0];
            if (!raw)
                throw new Error('playback_unavailable');
            const media = raw.Media || [];
            const index = args.variantId ? media.findIndex(m => String(m.id) === args.variantId) : 0;
            if (index < 0 || !media[index])
                throw new Error('selected_variant_unavailable');
            const selected = media[index];
            const parts = selected.Part || [];
            if (parts.length > 1)
                throw new Error('multipart_playback_unsupported');
            const part = parts[0];
            if (!part || !/^\/library\/parts\//.test(part.key || '') || part.exists === false || part.accessible === false)
                throw new Error('selected_variant_unplayable');
            const plan = playbackPlan(selected, args, known.some(c => c.uri === server && c.local), raw.type !== 'track');
            if (plan.bitrateKbps < 1)
                throw new Error('quality_unavailable');
            const session = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            const kind = raw.type === 'track' ? 'music' : 'video';
            const endpoint = '/' + kind + '/:/transcode/universal/';
            const parameters = {
                path: metadata(String(raw.ratingKey)), mediaIndex: index, partIndex: 0, protocol: 'hls',
                hasMDE: 1, fastSeek: 1, directPlay: 0, directStream: plan.directStream,
                directStreamAudio: plan.directStream, videoQuality: 100, maxVideoBitrate: plan.bitrateKbps,
                audioBitrate: kind === 'music' ? Math.min(320, plan.bitrateKbps) : undefined,
                videoResolution: plan.resolution, offset: Math.floor(milliseconds(args.positionTicks) / 1000),
                session: session, location: known.some(c => c.uri === server && c.local) ? 'lan' : 'wan',
                'X-Plex-Session-Identifier': session, 'X-Plex-Client-Identifier': String(device.id || 'spool'),
                'X-Plex-Product': 'Spool', 'X-Plex-Platform': 'Generic', 'X-Plex-Client-Profile-Name': 'Chrome'
            };
            if (plan.height)
                parameters['X-Plex-Client-Profile-Extra'] =
                    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.height&value='
                    + plan.height + '&isRequired=true)';
            function resolved(outputPart, method) {
                sessions[session] = { duration: raw.duration || selected.duration, partId: part.id, endpoint: endpoint };
                return {
                    url: method === 'DirectPlay' ? server + part.key : server + endpoint + 'start.m3u8?' + query(parameters),
                    headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': String(device.id || 'spool'),
                        'X-Plex-Session-Identifier': session },
                    variantId: String(selected.id), playSessionId: session, playMethod: method,
                    container: method === 'DirectPlay' ? selected.container || '' : 'mpegts',
                    streams: (outputPart.Stream || []).map(stream).filter(s => s.type), segments: segments(raw)
                };
            }
            if (plan.direct)
                return resolved(part, 'DirectPlay');
            if (kind === 'music')
                return resolved({ Stream: [] }, 'Transcode');
            // Ask the server before returning a URL: disabled transcoding,
            // insufficient permissions and rejected quality must surface here.
            return request(host, 'GET', endpoint + 'decision', parameters).then(decision => {
                const box = container(decision);
                if (['generalDecisionCode', 'mdeDecisionCode', 'transcodeDecisionCode']
                    .some(key => Number(box[key]) >= 2000))
                    throw new Error('transcode_unavailable');
                const output = ((((box.Metadata || [])[0] || {}).Media) || [])[0];
                const outputPart = output && (output.Part || [])[0];
                if (!outputPart)
                    throw new Error('transcode_unavailable');
                const outputVideo = (outputPart.Stream || []).find(s => s.streamType === 1);
                if (!outputVideo || outputPart.decision === 'directplay')
                    throw new Error('transcode_unavailable');
                if (Number(output.bitrate) * 1000 > plan.ceiling || plan.height
                    && Number((outputVideo && outputVideo.height) || output.height) > plan.height)
                    throw new Error('quality_unavailable');
                const videoDecision = outputVideo && outputVideo.decision;
                const copied = videoDecision === 'copy' || outputPart.decision === 'copy';
                if (!plan.directStream && copied)
                    throw new Error('quality_unavailable');
                if (args.restrictVideoCodecs && outputVideo && (args.videoCodecs || [])
                    .map(c => String(c).toLowerCase()).indexOf(String(outputVideo.codec || '').toLowerCase()) < 0)
                    throw new Error('unsupported_transcode_codec');
                return resolved(outputPart, copied ? 'DirectStream' : 'Transcode');
            });
        }),
        speedTest: (args, host) => request(host, 'GET', '/library/sections').then(result => {
            const types = { movie: 1, show: 4, artist: 10 };
            const libraries = (container(result).Directory || []).filter(d => types[d.type]);
            function find(index) {
                if (index >= libraries.length)
                    throw new Error('speed_test_unavailable');
                const library = libraries[index];
                return request(host, 'GET', '/library/sections/' + segment(String(library.key)) + '/all',
                    { type: types[library.type], 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 32 }).then(result => {
                    for (const row of container(result).Metadata || []) {
                        for (const media of row.Media || []) {
                            for (const part of media.Part || []) {
                                if (Number(part.size) >= 4 * 1024 * 1024 && part.exists !== false
                                    && part.accessible !== false && /^\/library\/parts\//.test(part.key || ''))
                                    return host.speedTest({ url: server + part.key, headers: headers(device, token),
                                        range: true });
                            }
                        }
                    }
                    return find(index + 1);
                });
            }
            return find(0);
        }),
        segments: (args, host) => request(host, 'GET', metadata(args.itemId), { includeMarkers: 1 })
            .then(result => ({ segments: segments((container(result).Metadata || [])[0]) })),
        report: (args, host) => {
            const state = { start: 'playing', progress: args.paused ? 'paused' : 'playing', stop: 'stopped' }[args.event];
            if (!state)
                throw new Error('invalid_report');
            const playback = sessions[args.playSessionId] || {};
            const timeline = request(host, 'GET', '/:/timeline', { ratingKey: args.itemId,
                key: metadata(args.itemId), state: state, time: milliseconds(args.positionTicks),
                duration: playback.duration, partID: playback.partId,
                'X-Plex-Session-Identifier': args.playSessionId }).then(() => ({}));
            if (args.event !== 'stop')
                return timeline;
            delete sessions[args.playSessionId];
            if (args.playMethod !== 'Transcode' && args.playMethod !== 'DirectStream')
                return timeline;
            // Stop the server session even if the final timeline update failed,
            // but do not turn either failure into a false reporting success.
            const stop = () => request(host, 'GET', (playback.endpoint || '/video/:/transcode/universal/') + 'stop',
                { session: args.playSessionId });
            return timeline.then(() => stop().then(() => ({})), error =>
                stop().then(() => { throw error; }, () => { throw error; }));
        },

        favorite: (args, host) => request(host, 'PUT', '/:/rate', { key: args.itemId, identifier: library,
            rating: args.value ? 10 : -1 }).then(() => ({})),
        played: (args, host) => request(host, 'GET', args.value ? '/:/scrobble' : '/:/unscrobble',
            { key: args.itemId, identifier: library }).then(() => ({})),
        progress: (args, host) => request(host, 'GET', '/:/progress', { key: args.itemId, identifier: library,
            time: milliseconds(args.positionTicks), state: 'stopped' }).then(() => ({})),

        // Item menu actions from manifest.json; `pick` shows ui/Picker.qml.
        runItemAction: (args, host) => {
            const kind = ['Audio', 'MusicAlbum', 'MusicArtist'].indexOf(args.itemType) >= 0 ? 'audio' : 'video';
            switch (args.action) {
            case 'playlist':
                if (!args.targetId && !args.newName)
                    return { pick: { kind: 'playlist', itemId: args.itemId, playlistType: kind } };
                if (args.newName)
                    return request(host, 'POST', '/playlists', { type: kind, title: args.newName, smart: 0,
                        uri: uri(args.itemId) }).then(() => ({ message: 'Added to ' + args.newName }));
                return request(host, 'PUT', '/playlists/' + segment(args.targetId) + '/items', { uri: uri(args.itemId) })
                    .then(() => ({ message: 'Added to ' + (args.targetName || 'playlist') }));
            case 'delete':
                if (!args.confirmed)
                    return { pick: { kind: 'confirm', itemId: args.itemId } };
                return request(host, 'DELETE', metadata(args.itemId)).then(() => ({ changed: true, message: 'Deleted' }));
            default:
                throw new Error('unsupported_action');
            }
        },
        // Where an item could be added, for the picker.
        targets: (args, host) => request(host, 'GET', '/playlists', { playlistType: args.playlistType || 'video',
            smart: 0 }).then(result => ({ items: (container(result).Metadata || [])
            .map(row => ({ id: String(row.ratingKey), title: row.title || '' })) })),

        signOut: () => {
            if (disconnect)
                disconnect();
            return {};
        }
    };
}
