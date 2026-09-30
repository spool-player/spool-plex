// SPDX-License-Identifier: MPL-2.0
// Plex for Spool: one source per Plex user and server.

import { collectionTypes, container, item, milliseconds, page, segments, stream } from './items.mjs';
import { connect } from './events.mjs';
import { playbackPlan } from './profile.mjs';
import { createPlayQueueReporter } from './play-queue.mjs';
import { createRemote } from './remote.mjs';
import { createHome } from './home.mjs';

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

// An address the viewer typed for their server, such as a custom access URL
// plex.tv does not advertise. A bare host name is taken to mean HTTPS.
export function customAddress(text) {
    let value = String(text || '').trim().replace(/\/+$/, '');
    if (!value)
        return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        value = 'https://' + value;
    return /^https?:\/\/[^\s/?#@]+$/i.test(value) ? value : '';
}

export function createSource(configuration, sourceHost) {
    const device = sourceHost.device || {};
    let token = configuration.token || '';
    let activeAccountToken = configuration.activeAccountToken || '';
    const serverId = configuration.serverId || '';
    let known = configuration.connections || [];
    let server = configuration.server || '';
    const sessions = {};
    let disconnect = null;
    const implementedExtensions = ['spool.speed-test', 'spool.suggestions', 'spool.item-actions',
        'spool.collection-editing', 'spool.playback-queue-reporting', 'spool.remote-targets',
        'spool.http-metadata', 'spool.origin-grants', 'spool.account-activation'];
    const negotiated = {};
    for (const id of implementedExtensions) {
        if (sourceHost.extensions && sourceHost.extensions[id] === 1)
            negotiated[id] = 1;
    }
    if (!negotiated['spool.http-metadata'] || !negotiated['spool.origin-grants'])
        delete negotiated['spool.remote-targets'];
    const extensions = Object.freeze(negotiated);
    const missingHost = implementedExtensions.filter(id => !extensions[id]);
    if (configuration.homeProtected === true && !extensions['spool.account-activation'])
        throw new Error('activation_host_required');
    if (configuration.homeProtected === true && (!configuration.homeFamilyId || !configuration.userId))
        throw new Error('home_relink_required');
    let active = !configuration.server || !extensions['spool.account-activation'];
    let stopped = false;
    const denied = new Set();
    let policy = null;

    function requireExtension(id) {
        if (extensions[id] !== 1)
            throw new Error('unsupported_extension');
    }

    function tv(host, method, path, parameters, userToken) {
        const suffix = query(parameters || {});
        return host.http(plexTv + path + (suffix ? '?' + suffix : ''), { method: method,
            headers: headers(device, userToken) }).then(parse);
    }

    // A server that stops answering at one address is tried at the others
    // it was signed in with, and the one that answers is remembered.
    function request(host, method, path, parameters) {
        if (!active || stopped) throw new Error('account_locked');
        openSocket();
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
                if (method !== 'GET' || code(error) !== 'network_error' || index + 1 >= candidates.length)
                    throw error;
                return attempt(index + 1);
            });
        }
        return attempt(0);
    }

    const queueReporter = createPlayQueueReporter({ host: sourceHost,
        request: (method, path, parameters) => request(sourceHost, method, path, parameters),
        baseUrlLength: () => server.length });
    const makeRemote = () => createRemote({ host: sourceHost, extensions: extensions, request: request, tv: tv,
        server: () => server, serverId: serverId, token: token,
        activeAccountToken: activeAccountToken,
        linkedAccountToken: configuration.linkedAccountToken || '' });
    let remote = makeRemote();
    function serverResources(resources) {
        return (Array.isArray(resources) ? resources : [])
            .filter(r => String(r.provides || '').split(',').indexOf('server') >= 0
                && typeof r.accessToken === 'string' && r.accessToken.length > 0)
            .map(r => ({ id: r.clientIdentifier, name: r.name || '', token: r.accessToken,
                connections: connections(r.connections), owned: r.owned }));
    }
    function openSocket() {
        if (server && token && sourceHost.socket && !disconnect && !stopped)
            disconnect = connect(sourceHost, server.replace(/^http/i, 'ws') + '/:/websockets/notifications',
                headers(device, token));
    }
    const home = createHome({ configuration: configuration, extensions: extensions, tv: tv,
        headers: value => headers(device, value), servers: serverResources,
        emit: (event, value) => sourceHost.emit(event, value),
        refreshServer: (host, target, activeToken) => {
            // Resource refresh does not silently grant newly advertised origins,
            // and keeps the ones already approved even when plex.tv does not
            // list them, such as a typed custom access URL. The address that
            // last answered goes first.
            const approved = [server].concat(known.map(c => c.uri));
            const candidates = [];
            for (const c of [{ uri: server }].concat(known, target.connections)) {
                if (c.uri && approved.includes(c.uri) && !candidates.some(seen => seen.uri === c.uri))
                    candidates.push({ uri: c.uri, local: Boolean(c.local) });
            }
            function attempt(index) {
                if (index >= candidates.length) throw new Error('home_server_unavailable');
                const candidate = candidates[index];
                return host.http(candidate.uri + '/', { headers: headers(device, target.token) }).then(parse)
                    .then(result => {
                        if (container(result).machineIdentifier !== serverId) throw new Error('home_server_identity_mismatch');
                        if (stopped) throw new Error('cancelled');
                        server = candidate.uri;
                        token = target.token;
                        known = candidates;
                        activeAccountToken = activeToken;
                        sourceHost.emit('configuration', { server: server, connections: known, token: token,
                            activeAccountToken: activeToken, owned: target.owned });
                    }, error => {
                        if (code(error) !== 'network_error' || index + 1 >= candidates.length) throw error;
                        return attempt(index + 1);
                    });
            }
            return Promise.resolve().then(() => attempt(0));
        } });

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

    function accountPolicy(host) {
        if (!policy)
            policy = request(host, 'GET', '/').then(result => container(result), error => {
                policy = null;
                throw error;
            });
        return policy;
    }

    function isFalse(value) {
        return value === false || value === 0 || value === '0';
    }

    function isTrue(value) {
        return value === true || value === 1 || value === '1';
    }

    function writable(raw) {
        return !isTrue(raw.smart) && !isTrue(raw.radio) && !isTrue(raw.readOnly) && !isFalse(raw.canEdit)
            && !isFalse(raw.canEditItems);
    }

    function mutation(host, method, path, parameters, permissionKey) {
        if (denied.has(permissionKey))
            throw new Error('permission_denied');
        return request(host, method, path, parameters).catch(error => {
            if (code(error) === 'http_403') {
                policy = null;
                denied.add(permissionKey);
                throw new Error('permission_denied');
            }
            throw error;
        });
    }

    function rawItem(host, id) {
        return request(host, 'GET', metadata(id)).catch(error => {
            if (code(error) !== 'http_404')
                throw error;
            return request(host, 'GET', '/playlists/' + segment(id));
        }).then(result => {
            const raw = (container(result).Metadata || container(result).Directory || [])[0];
            if (!raw)
                throw new Error('http_404');
            return raw;
        });
    }

    function collectionState(host, id) {
        return rawItem(host, id).then(raw => {
            if (raw.type !== 'playlist' && raw.type !== 'collection')
                throw new Error('collection_unavailable');
            const playlist = raw.type === 'playlist';
            const editable = writable(raw) && !denied.has('edit:' + id)
                && (playlist || !isFalse(configuration.owned));
            const ordered = playlist || Number(raw.collectionSort) === 2;
            return { raw: raw, path: playlist ? '/playlists/' + segment(id)
                : '/library/collections/' + segment(id), playlist: playlist,
            info: { ordered: ordered, removable: editable, moveMode: editable && ordered ? 'after' : 'none' } };
        });
    }

    function ensureEditable(state) {
        if (!state.info.removable)
            throw new Error('permission_denied');
    }

    const collectionItemTypes = { movie: 1, show: 2, season: 3, episode: 4, artist: 8, album: 9, track: 10 };

    function actionPolicy(host, args) {
        return Promise.all([rawItem(host, args.itemId), accountPolicy(host)]).then(([raw, account]) => {
            const collection = raw.type === 'collection';
            const playlist = raw.type === 'playlist';
            const manageCollections = !isFalse(configuration.owned);
            const deleteAllowed = !isFalse(raw.canDelete) && !isTrue(raw.readOnly) && !isTrue(raw.smart) && !isTrue(raw.radio)
                && (playlist || !isFalse(configuration.owned) && !isFalse(account.allowMediaDeletion));
            const actions = [];
            if (['movie', 'episode', 'track', 'album', 'clip'].indexOf(raw.type) >= 0
                && !denied.has('playlist'))
                actions.push({ id: 'playlist', label: 'Add to playlist', icon: 'playlist_add' });
            if (extensions['spool.item-actions'] === 1 && manageCollections) {
                if (collectionItemTypes[raw.type] && raw.librarySectionID !== undefined && !denied.has('collection'))
                    actions.push({ id: 'collection', label: 'Add to collection', icon: 'library_add' });
                if (collection && raw.librarySectionID !== undefined && writable(raw) && !denied.has('edit:' + args.itemId)) {
                    actions.push({ id: 'renameCollection', label: 'Rename collection', icon: 'edit' });
                    actions.push({ id: 'collectionSort', label: 'Collection order', icon: 'sort' });
                }
            }
            if (deleteAllowed && !denied.has('delete:' + args.itemId))
                actions.push({ id: 'delete', label: 'Delete from server', icon: 'delete' });
            return { actions: actions, raw: raw };
        });
    }

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
            inProgress: status.indexOf('IsResumable') >= 0 ? 1 : undefined,
            resolution: filters.is4K ? '4k' : undefined,
            hdr: filters.isHdr ? 1 : undefined
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

    if (active) openSocket();

    const source = {
        extensionStatus: () => ({ enabled: extensions, missingHost: missingHost }),
        describe: () => {
            const description = { extensions: extensions };
            if (home.activation) description.activation = home.activation;
            if (active && server && token)
                description.artwork = server + '/photo/:/transcode?width={width}&height=4320&minSize=0&upscale=0&url={tag}&X-Plex-Token='
                    + encodeURIComponent(token);
            return description;
        },
        activate: (args, host) => home.activate(args, host).then(result => {
            if (!result.pick) {
                if (stopped) throw new Error('cancelled');
                active = true;
                remote.stop();
                remote = makeRemote();
            }
            return result;
        }),
        homeSelect: home.select,
        homeSettings: home.settings,
        homeAutomaticSignIn: home.setAutomatic,
        remoteTargets: (args, host) => remote.remoteTargets(args, host),
        remoteConnect: (args, host) => remote.remoteConnect(args, host),
        remoteState: (args, host) => remote.remoteState(args, host),
        remoteQueue: (args, host) => remote.remoteQueue(args, host),
        remoteCommand: (args, host) => remote.remoteCommand(args, host),
        remoteControls: (args, host) => remote.remoteControls(args, host),
        remoteControl: (args, host) => remote.remoteControl(args, host),

        // Sign-in: a code linked at plex.tv/link, then one of the account's
        // servers. These run before the account exists.
        pinStart: (args, host) => tv(host, 'POST', '/api/v2/pins', { strong: false })
            .then(pin => ({ id: String(pin.id), code: pin.code })),
        pinPoll: (args, host) => tv(host, 'GET', '/api/v2/pins/' + segment(String(args.id || ''))).then(pin => {
            if (!pin.authToken)
                return { pending: true };
            return tv(host, 'GET', '/api/v2/user', {}, pin.authToken)
                .then(user => home.linked(host, user, pin.authToken));
        }),
        // Which server answers at a typed address. Plex serves its identity
        // without a token, so this names the server before trusting it.
        identify: (args, host) => {
            const address = customAddress(args.address);
            if (!address)
                throw new Error('invalid_address');
            return host.http(address + '/identity', { headers: headers(device) }).then(parse)
                .then(result => ({ address: address, id: String(container(result).machineIdentifier || '') }));
        },
        // The authenticated root both verifies the token and checks that an
        // advertised address still belongs to the selected server.
        connect: (args, host) => {
            const target = args.server || {};
            const user = args.user || {};
            // A typed address is tried first and kept with the advertised ones;
            // like them, it must prove it is the chosen server below.
            const typed = customAddress(args.address);
            const candidates = (typed ? [{ uri: typed, local: false }] : [])
                .concat((target.connections || []).filter(c => c.uri !== typed));
            const reachable = c => Promise.race([
                host.http(c.uri + '/', { headers: headers(device, target.token) }).then(parse)
                    .then(result => container(result).machineIdentifier === target.id, () => false),
                host.delay(4000).then(() => false)
            ]);
            // A typed address is asked alone first: the viewer chose it, and the
            // advertised ones may be addresses that cannot work from here.
            const first = typed ? reachable(candidates[0]).then(ok => ok ? [true] : null) : Promise.resolve(null);
            return first.then(answer => answer || Promise.all(candidates.map(reachable))).then(answers => {
                const chosen = candidates[answers.indexOf(true)];
                if (!chosen)
                    throw new Error('server_unreachable');
                return {
                    account: user.id + '@' + target.id, group: target.id, label: user.name || '', detail: target.name || '',
                    configuration: { server: chosen.uri, connections: candidates, token: target.token,
                        serverId: target.id, serverName: target.name || '', userId: user.id, userName: user.name || '',
                        owned: target.owned, activeAccountToken: user.activeAccountToken || '',
                        linkedAccountToken: user.linkedAccountToken || '',
                        homeFamilyId: user.homeFamilyId || '', homeProtected: user.homeProtected === true,
                        homeManaged: user.homeManaged === true }
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
        suggestions: (args, host) => {
            requireExtension('spool.suggestions');
            const limit = Math.min(Math.max(args.limit || 40, 1), 60);
            return request(host, 'GET', '/hubs', { count: limit }).then(result => {
                const rows = [];
                const seen = new Set();
                for (const hub of container(result).Hub || []) {
                    const identity = String(hub.hubIdentifier || '') + ' ' + String(hub.key || '');
                    if (!['movie', 'show'].includes(hub.type)
                        || /continue|on.?deck|in.?progress|recently.?viewed/i.test(identity))
                        continue;
                    for (const raw of hub.Metadata || []) {
                        if (!['movie', 'show'].includes(raw.type) || !raw.ratingKey || seen.has(String(raw.ratingKey))
                            || isFalse(raw.accessible) || isTrue(raw.unavailable) || isTrue(raw.deleted)
                            || raw.source && raw.source !== library
                            || raw.machineIdentifier && raw.machineIdentifier !== serverId
                            || raw.key && !/^\/library\/metadata\//.test(raw.key))
                            continue;
                        seen.add(String(raw.ratingKey));
                        rows.push(item(raw));
                        if (rows.length === limit)
                            return { items: rows, cursor: null, exhausted: true };
                    }
                }
                return { items: rows, cursor: null, exhausted: true };
            });
        },
        itemActions: (args, host) => {
            requireExtension('spool.item-actions');
            return actionPolicy(host, args).then(result => ({ actions: result.actions }));
        },
        collectionInfo: (args, host) => {
            requireExtension('spool.collection-editing');
            return collectionState(host, args.containerId).then(state => state.info);
        },
        collectionEntries: (args, host) => {
            requireExtension('spool.collection-editing');
            return collectionState(host, args.containerId).then(state =>
                list(host, state.path + (state.playlist ? '/items' : '/children'), args).then(result => {
                    for (const row of result.items) {
                        if (!state.playlist)
                            row.entryId = row.id;
                        if (!row.entryId)
                            throw new Error('invalid_collection_entry');
                    }
                    return result;
                }));
        },
        collectionRemove: (args, host) => {
            requireExtension('spool.collection-editing');
            return collectionState(host, args.containerId).then(state => {
                ensureEditable(state);
                return mutation(host, 'DELETE', state.path + '/items/' + segment(args.entryId), {},
                    'edit:' + args.containerId).then(() => ({}));
            });
        },
        collectionMove: (args, host) => {
            requireExtension('spool.collection-editing');
            if (!Number.isSafeInteger(args.index) || args.index < 0
                || (args.index === 0 ? args.afterEntryId !== null
                    : typeof args.afterEntryId !== 'string' || !args.afterEntryId)
                || args.afterEntryId === args.entryId)
                throw new Error('invalid_move');
            return collectionState(host, args.containerId).then(state => {
                ensureEditable(state);
                if (state.info.moveMode !== 'after')
                    throw new Error('collection_order_unavailable');
                return mutation(host, 'PUT', state.path + '/items/' + segment(args.entryId) + '/move',
                    { after: args.afterEntryId }, 'edit:' + args.containerId).then(() => ({}));
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
            // The filters Plex answers; Spool offers only these. Resolution and
            // HDR belong to a movie's media, not to a show as a whole.
            const supported = ['filters:IsPlayed', 'filters:IsUnplayed', 'filters:IsResumable', 'genres', 'years',
                'officialRatings'].concat(args.collectionType === 'movies' ? ['is4K', 'isHdr'] : []);
            return Promise.all([titles('/genre'), titles('/year'), titles('/contentRating')])
                .then(([genres, years, ratings]) => ({ genres: genres, years: years.map(Number).filter(Number.isInteger),
                    officialRatings: ratings, supported: supported }));
        },

        resolve: (args, host) => {
            const positionMs = milliseconds(args.positionTicks);
            return request(host, 'GET', metadata(args.itemId), { includeMarkers: 1 }).then(result => {
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
                    videoResolution: plan.resolution, offset: Math.floor(positionMs / 1000),
                    session: session, location: known.some(c => c.uri === server && c.local) ? 'lan' : 'wan',
                    'X-Plex-Session-Identifier': session, 'X-Plex-Client-Identifier': String(device.id || 'spool'),
                    'X-Plex-Product': 'Spool', 'X-Plex-Platform': 'Generic', 'X-Plex-Client-Profile-Name': 'Chrome'
                };
                if (plan.height)
                    parameters['X-Plex-Client-Profile-Extra'] =
                        'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.height&value='
                        + plan.height + '&isRequired=true)';
                // Sidecar subtitles have no index in the file: number them past
                // any it could have, and give mpv the file to fetch.
                let sidecars = 0;
                const mapStream = rawStream => {
                    const mapped = stream(rawStream);
                    if (!mapped.external)
                        return mapped;
                    return Object.assign(mapped, { index: 10000 + sidecars++,
                        url: /^\/library\/streams\/\d+/.test(String(rawStream.key)) ? server + rawStream.key : undefined });
                };
                function resolved(outputPart, method) {
                    sessions[session] = { duration: raw.duration || selected.duration, partId: part.id, endpoint: endpoint };
                    return {
                        url: method === 'DirectPlay' ? server + part.key : server + endpoint + 'start.m3u8?' + query(parameters),
                        headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': String(device.id || 'spool'),
                            'X-Plex-Session-Identifier': session },
                        variantId: String(selected.id), playSessionId: session, playMethod: method,
                        container: method === 'DirectPlay' ? selected.container || '' : 'mpegts',
                        streams: (outputPart.Stream || []).map(mapStream).filter(s => s.type), segments: segments(raw)
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
            });
        },
        speedTest: (args, host) => {
            if (extensions['spool.speed-test'] !== 1)
                throw new Error('unsupported_extension');
            return request(host, 'GET', '/library/sections').then(result => {
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
            });
        },
        segments: (args, host) => request(host, 'GET', metadata(args.itemId), { includeMarkers: 1 })
            .then(result => ({ segments: segments((container(result).Metadata || [])[0]) })),
        report: (args, host) => {
            const state = { start: 'playing', progress: args.paused ? 'paused' : 'playing', stop: 'stopped' }[args.event];
            if (!state)
                throw new Error('invalid_report');
            const playback = sessions[args.playSessionId] || {};
            const positionMs = milliseconds(args.positionTicks);
            if (args.event !== 'stop')
                queueReporter.update(args.queue, args.queueIndex);
            const timeline = request(host, 'GET', '/:/timeline', Object.assign({ ratingKey: args.itemId,
                key: metadata(args.itemId), state: state, time: positionMs,
                duration: playback.duration, partID: playback.partId,
                'X-Plex-Session-Identifier': args.playSessionId }, queueReporter.timeline(args.itemId))).then(() => ({}));
            if (args.event !== 'stop')
                return timeline;
            queueReporter.stop();
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
            if (['collection', 'renameCollection', 'collectionSort'].includes(args.action))
                requireExtension('spool.item-actions');
            return actionPolicy(host, args).then(({ actions, raw }) => {
                if (!actions.some(action => action.id === args.action))
                    throw new Error('permission_denied');
                const kind = ['track', 'album', 'artist'].includes(raw.type) ? 'audio' : 'video';
                const name = String(args.newName || '').trim();
                switch (args.action) {
                case 'playlist':
                    if (!args.targetId && !name)
                        return { pick: { kind: 'playlist', itemId: args.itemId, playlistType: kind } };
                    if (name)
                        return mutation(host, 'POST', '/playlists', { type: kind, title: name, smart: 0,
                            uri: uri(args.itemId) }, 'playlist').then(() => ({ message: 'Added to ' + name }));
                    return collectionState(host, args.targetId).then(state => {
                        ensureEditable(state);
                        if (!state.playlist || state.raw.playlistType !== kind)
                            throw new Error('invalid_collection_target');
                        return mutation(host, 'PUT', state.path + '/items', { uri: uri(args.itemId) },
                            'edit:' + args.targetId).then(() => ({ message: 'Added to playlist' }));
                    });
                case 'collection':
                    if (!args.targetId && !name)
                        return { pick: { kind: 'collection', itemId: args.itemId } };
                    if (name)
                        return mutation(host, 'POST', '/library/collections', { type: collectionItemTypes[raw.type],
                            title: name, smart: 0, sectionId: raw.librarySectionID, uri: uri(args.itemId) },
                        'collection').then(() => ({ message: 'Added to ' + name }));
                    return collectionState(host, args.targetId).then(state => {
                        ensureEditable(state);
                        if (state.playlist || String(state.raw.librarySectionID) !== String(raw.librarySectionID)
                            || state.raw.subtype && state.raw.subtype !== raw.type)
                            throw new Error('invalid_collection_target');
                        return mutation(host, 'PUT', state.path + '/items', { uri: uri(args.itemId) },
                            'edit:' + args.targetId).then(() => ({ message: 'Added to collection' }));
                    });
                case 'renameCollection':
                    if (!name)
                        return { pick: { kind: 'renameCollection', itemId: args.itemId, title: raw.title || '' } };
                    return mutation(host, 'PUT', '/library/sections/' + segment(String(raw.librarySectionID)) + '/all',
                        { type: 18, id: args.itemId, 'title.value': name, 'title.locked': 1 },
                    'edit:' + args.itemId).then(() => ({ changed: true }));
                case 'collectionSort':
                    if (args.sort === undefined)
                        return { pick: { kind: 'collectionSort', itemId: args.itemId } };
                    if (![0, 1, 2].includes(args.sort))
                        throw new Error('invalid_sort');
                    return mutation(host, 'PUT', metadata(args.itemId) + '/prefs',
                        { collectionSort: args.sort }, 'edit:' + args.itemId).then(() => ({ changed: true }));
                case 'delete':
                    if (!args.confirmed)
                        return { pick: { kind: 'confirm', itemId: args.itemId } };
                    return mutation(host, 'DELETE', raw.type === 'playlist' ? '/playlists/' + segment(args.itemId)
                        : raw.type === 'collection' ? '/library/collections/' + segment(args.itemId) : metadata(args.itemId),
                    {}, 'delete:' + args.itemId).then(() => ({ changed: true, message: 'Deleted' }));
                default:
                    throw new Error('unsupported_action');
                }
            });
        },
        // Paged, permission-filtered destinations; opening this picker is the first policy read.
        targets: (args, host) => {
            const collections = args.kind === 'collection';
            if (collections)
                requireExtension('spool.item-actions');
            return actionPolicy(host, args).then(({ actions, raw }) => {
                if (!actions.some(action => action.id === (collections ? 'collection' : 'playlist')))
                    throw new Error('permission_denied');
                const first = start(args);
                const limit = 100;
                return request(host, 'GET', collections
                    ? '/library/sections/' + segment(String(raw.librarySectionID)) + '/collections' : '/playlists',
                { playlistType: collections ? undefined : args.playlistType || 'video', smart: 0,
                    'X-Plex-Container-Start': first, 'X-Plex-Container-Size': limit }).then(result => {
                    const box = container(result);
                    const rows = box.Metadata || box.Directory || [];
                    const exhausted = Number.isSafeInteger(box.totalSize) ? first + rows.length >= box.totalSize
                        : rows.length < limit;
                    return { items: rows.filter(row => writable(row) && !denied.has('edit:' + row.ratingKey)
                        && (!collections || !row.subtype || row.subtype === raw.type))
                        .map(row => ({ id: String(row.ratingKey), title: row.title || '' })),
                    cursor: exhausted ? null : String(first + rows.length), exhausted: exhausted };
                });
            });
        },

        signOut: () => {
            stopped = true;
            active = false;
            home.stop();
            queueReporter.stop();
            remote.stop();
            if (disconnect)
                disconnect();
            return {};
        }
    };
    for (const name of ['pinStart', 'pinPoll', 'homeSelect', 'identify', 'connect']) {
        const operation = source[name];
        source[name] = (args, host) => {
            if (configuration.server || stopped) throw new Error('action_unavailable');
            return operation(args, host);
        };
    }
    // Defense in depth: even custom baseline operations cannot use saved
    // credentials while a prepared Home source is private/locked.
    const utilities = ['describe', 'extensionStatus', 'activate', 'signOut', 'pinStart', 'pinPoll', 'homeSelect',
        'identify', 'connect'];
    for (const name of Object.keys(source)) {
        if (utilities.includes(name)) continue;
        const operation = source[name];
        source[name] = (args, host) => {
            if (!active || stopped) throw new Error('account_locked');
            return operation(args, host);
        };
    }
    return source;
}
