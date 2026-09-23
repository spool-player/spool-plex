// SPDX-License-Identifier: MPL-2.0
// Plex for Spool: one source per Plex user and server.

import { collectionTypes, container, item, milliseconds, page, segments, stream } from './items.mjs';
import { connect } from './events.mjs';

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

// Local addresses first, then remote, then Plex's relay; a local server is
// also tried over plain HTTP in case its certificate name does not resolve.
export function connections(list) {
    const rank = c => (c.relay ? 2 : c.local ? 0 : 1);
    const sorted = (list || []).filter(c => /^https?:\/\//.test(String(c.uri || ''))).sort((a, b) => rank(a) - rank(b));
    const result = [];
    const add = (uri, local) => {
        if (!result.some(c => c.uri === uri))
            result.push({ uri: uri.replace(/\/+$/, ''), local: local });
    };
    for (const c of sorted) {
        add(c.uri, Boolean(c.local) && !c.relay);
        if (c.local && !c.relay && c.address && c.port)
            add('http://' + c.address + ':' + c.port, true);
    }
    return result;
}

export function createSource(configuration, sourceHost) {
    const device = sourceHost.device || {};
    const token = configuration.token || '';
    const serverId = configuration.serverId || '';
    const known = configuration.connections || [];
    let server = configuration.server || '';

    function tv(host, method, path, parameters, userToken) {
        const suffix = query(parameters || {});
        return host.http(plexTv + path + (suffix ? '?' + suffix : ''), { method: method,
            headers: headers(device, userToken) }).then(parse);
    }

    // A server that stops answering at one address is tried at the others
    // it was signed in with, and the one that answers is remembered.
    function request(host, method, path, parameters) {
        const suffix = query(parameters || {});
        const attempt = base => host.http(base + path + (suffix ? '?' + suffix : ''),
            { method: method, headers: headers(device, token) }).then(parse);
        return attempt(server).catch(error => {
            if (code(error) !== 'network_error')
                throw error;
            return known.map(c => c.uri).filter(uri => uri !== server).reduce((chain, base) => chain.catch(() =>
                attempt(base).then(result => {
                    server = base;
                    sourceHost.emit('configuration', { server: base });
                    return result;
                })), Promise.reject(error));
        });
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

    let disconnect = null;
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
        pinStart: (args, host) => tv(host, 'POST', '/api/v2/pins').then(pin => ({ id: String(pin.id), code: pin.code })),
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
        // Every address was allowed by the screen; the first that answers,
        // in the order connections() put them, is where requests go.
        connect: (args, host) => {
            const target = args.server || {};
            const user = args.user || {};
            const candidates = target.connections || [];
            const reachable = c => Promise.race([
                host.http(c.uri + '/identity', { headers: headers(device, target.token) })
                    .then(response => response.status >= 200 && response.status < 300, () => false),
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
            // A genre or studio followed from an item: every library of that kind.
            return request(host, 'GET', '/library/sections').then(result => {
                const wanted = (container(result).Directory || [])
                    .filter(d => !args.collectionType || collectionTypes[d.type] === args.collectionType);
                const limit = Math.min(Math.max(args.limit || 72, 1), 100);
                return Promise.all(wanted.map(d => sectionParameters(host, String(d.key), args)
                    .then(parameters => list(host, '/library/sections/' + d.key + '/all', { limit: limit }, parameters))))
                    .then(pages => ({ items: [].concat(...pages.map(p => p.items)).slice(0, limit), cursor: null,
                        exhausted: true }));
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
            // Never swap in a different edition than the one asked for.
            if (index < 0 || !media[index])
                throw new Error('selected_variant_unavailable');
            const part = (media[index].Part || [])[0];
            if (!part || !part.key)
                throw new Error('selected_variant_unplayable');
            const streams = (part.Stream || []).map(stream).filter(s => s.type);
            const video = streams.find(s => s.type === 'Video');
            const ceiling = args.maxBitrate || args.preferredMaxBitrate || 0;
            const height = args.maxHeight || args.preferredMaxHeight || 0;
            const local = known.some(c => c.uri === server && c.local);
            const codecs = (args.videoCodecs || []).map(c => String(c).toLowerCase());
            const decodable = !args.restrictVideoCodecs || !video || codecs.indexOf(video.codec.toLowerCase()) >= 0;
            const fits = (!ceiling || (media[index].bitrate || 0) * 1000 <= ceiling || (args.unlimitedLocalNetwork && local))
                && (!height || !video || video.height <= height);
            const session = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            const direct = !args.forceTranscode && decodable && fits;
            const url = direct ? server + part.key : server + '/video/:/transcode/universal/start.m3u8?' + query({
                path: '/library/metadata/' + raw.ratingKey, mediaIndex: index, partIndex: 0, protocol: 'hls',
                fastSeek: 1, directPlay: 0, directStream: args.forceTranscode ? 0 : 1, directStreamAudio: 1,
                videoQuality: 100, maxVideoBitrate: ceiling ? Math.round(ceiling / 1000) : undefined,
                videoResolution: height ? Math.round(height * 16 / 9) + 'x' + height : undefined,
                offset: Math.floor(milliseconds(args.positionTicks) / 1000), session: session,
                'X-Plex-Session-Identifier': session, 'X-Plex-Client-Identifier': device.id, 'X-Plex-Product': 'Spool',
                'X-Plex-Platform': 'Generic'
            });
            return {
                url: url, headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': String(device.id || 'spool'),
                    'X-Plex-Session-Identifier': session },
                variantId: String(media[index].id), playSessionId: session, playMethod: direct ? 'DirectPlay' : 'Transcode',
                container: direct ? media[index].container || '' : 'mpegts', streams: streams, segments: segments(raw)
            };
        }),
        segments: (args, host) => request(host, 'GET', metadata(args.itemId), { includeMarkers: 1 })
            .then(result => ({ segments: segments((container(result).Metadata || [])[0]) })),
        report: (args, host) => {
            const state = { start: 'playing', progress: args.paused ? 'paused' : 'playing', stop: 'stopped' }[args.event];
            if (!state)
                throw new Error('invalid_report');
            const timeline = request(host, 'GET', '/:/timeline', { ratingKey: args.itemId,
                key: '/library/metadata/' + args.itemId, state: state, time: milliseconds(args.positionTicks),
                'X-Plex-Session-Identifier': args.playSessionId }).then(() => ({}));
            if (args.event !== 'stop' || args.playMethod !== 'Transcode')
                return timeline;
            // A transcode runs on until told otherwise.
            return timeline.then(() => request(host, 'GET', '/video/:/transcode/universal/stop',
                { session: args.playSessionId })).then(() => ({}), () => ({}));
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
