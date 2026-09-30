// SPDX-License-Identifier: MPL-2.0
// The provider against a scripted Plex Media Server and plex.tv, in Qt's own
// JS engine (sdk/provider-contract-runner). Covers what Spool relies on:
// headers and tokens, the link-code sign-in, choosing a reachable address and
// failing over, paging, filters, items, direct play and transcoding, markers,
// reporting, item actions and notifications.

import { connections, createSource } from '../logic/provider.mjs';
import { translate } from '../logic/events.mjs';
import { run as regressions } from './regressions.mjs';
import { run as catalogue } from './catalogue.mjs';
import { run as playQueue } from './play-queue.mjs';
import { run as remoteContracts } from './remote.mjs';
import { run as home } from './home.mjs';

let step = 'start';
function check(value, message) {
    if (!value)
        throw new Error('contract: ' + step + ': ' + message);
}
function respond(value, status) {
    return Promise.resolve({ status: status || 200, body: value === undefined ? '' : JSON.stringify(value) });
}
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => check(false, 'expected ' + code), error => check(error.message === code,
        'expected ' + code + ', got ' + error.message));
}

const device = { id: 'device-1', name: 'Living Room', app: 'Spool', version: '1.0', platform: 'test', locale: 'en' };

// Routes keyed by "METHOD origin/path"; origins listed in `down` refuse to
// connect, as an unreachable address does.
function server(routes, down) {
    const calls = [];
    const events = [];
    return {
        calls: calls,
        events: events,
        host: {
            device: device, delay: () => new Promise(() => {}), emit: (type, payload) => events.push([type, payload]),
            http: (url, options) => {
                const method = (options && options.method) || 'GET';
                const origin = url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
                const path = url.slice(origin.length).split('?')[0];
                calls.push({ method: method, url: url, origin: origin, path: path, options: options });
                if ((down || []).indexOf(origin) >= 0)
                    return Promise.reject('network_error');
                const route = routes[method + ' ' + origin + path];
                if (route === undefined)
                    return respond({}, 404);
                return typeof route === 'function' ? route(calls[calls.length - 1]) : respond(route);
            }
        }
    };
}

const local = 'https://10-0-0-2.abc.plex.direct:32400';
const remote = 'https://203-0-113-9.abc.plex.direct:32400';
const film = { ratingKey: '10', key: '/library/metadata/10', type: 'movie', title: 'Film', titleSort: 'Film', year: 2020,
    duration: 7200000, viewOffset: 60000, viewCount: 0, userRating: 10, librarySectionID: 1,
    Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://42' }], Genre: [{ tag: 'Drama' }], Role: [{ id: 7, tag: 'Ann', role: 'Lead' }],
    Marker: [{ type: 'intro', startTimeOffset: 1000, endTimeOffset: 31000 }, { type: 'credits', startTimeOffset: 7000000,
        endTimeOffset: 7200000 }, { type: 'unknown' }],
    Media: [{ id: 100, videoResolution: '4k', bitrate: 40000, container: 'mkv', Part: [{ id: 1000,
        key: '/library/parts/1000/1/file.mkv', file: '/srv/private/Film.mkv', size: 9007199254740993, Stream: [
            { streamType: 1, index: 0, codec: 'hevc', height: 2160, DOVIPresent: true },
            { streamType: 2, index: 1, codec: 'eac3', channels: 6, languageCode: 'eng' },
            { streamType: 3, codec: 'srt', key: '/library/streams/9' }] }] },
    { id: 101, videoResolution: '1080', bitrate: 8000, container: 'mp4', Part: [{ id: 1001,
        key: '/library/parts/1001/1/file.mp4', file: 'D:\\media\\Film.mp4', Stream: [
            { streamType: 1, index: 0, codec: 'h264', height: 1080 },
            { streamType: 3, codec: 'srt', key: '/library/streams/12', languageTag: 'en' }] }] }] };
const episode = { ratingKey: '20', type: 'episode', title: 'Pilot', index: 1, parentIndex: 0, parentRatingKey: '19',
    grandparentRatingKey: '18', grandparentTitle: 'Show', thumb: '/still', grandparentThumb: '/poster', leafCount: 0 };

function account(down) {
    const pms = server({
        ['GET ' + local + '/']: { MediaContainer: {} },
        ['GET ' + local + '/library/sections/1/all']: { MediaContainer: { totalSize: 3, Metadata: [film] } },
        ['GET ' + remote + '/library/sections/1/all']: { MediaContainer: { totalSize: 3, Metadata: [film] } },
        ['GET ' + local + '/library/sections/1/genre']: { MediaContainer: { Directory: [{ key: '55', title: 'Drama' }] } },
        ['GET ' + local + '/library/sections']: { MediaContainer: { Directory: [{ key: '1', title: 'Films', type: 'movie' },
            { key: '2', title: 'Shows', type: 'show' }] } },
        ['GET ' + local + '/library/metadata/10']: { MediaContainer: { Metadata: [film] } },
        ['GET ' + local + '/library/onDeck']: { MediaContainer: { Metadata: [film, episode] } },
        ['GET ' + local + '/hubs/search']: { MediaContainer: { Hub: [{ type: 'movie', Metadata: [film] },
            { type: 'place', Metadata: [{ ratingKey: 'x', type: 'place' }] }, { type: 'episode', Metadata: [episode] }] } },
        ['GET ' + local + '/video/:/transcode/universal/decision']: { MediaContainer: {
            generalDecisionCode: 1001, transcodeDecisionCode: 1001, Metadata: [{ Media: [{ bitrate: 18000,
                Part: [{ decision: 'transcode', Stream: [
                    { streamType: 1, index: 0, codec: 'h264', height: 1080, decision: 'transcode' },
                    { streamType: 2, index: 1, codec: 'aac' }] }] }] }] } },
        ['GET ' + local + '/:/timeline']: {},
        ['GET ' + local + '/video/:/transcode/universal/stop']: {},
        ['POST ' + local + '/playlists']: {},
        ['DELETE ' + local + '/library/metadata/10']: {}
    }, down);
    const source = createSource({ server: local, token: 'server-token', serverId: 'machine',
        connections: [{ uri: local, local: true }, { uri: remote, local: false }] }, { device: device, emit: pms.host.emit });
    return { pms: pms, source: source };
}

function extensionCompatibility() {
    step = 'optional speed extension';
    const legacy = account();
    const current = createSource({}, { device: device, extensions: { 'spool.speed-test': 1, 'future.feature': 1 } });
    const wrong = createSource({}, { device: device, extensions: { 'spool.speed-test': 2 } });
    const stringVersion = createSource({}, { device: device, extensions: { 'spool.speed-test': '1' } });
    check(Object.keys(legacy.source.describe().extensions).length === 0
        && legacy.source.extensionStatus().missingHost.indexOf('spool.suggestions') >= 0,
        'an old host advertises no optional features regardless of device version');
    check(current.describe().extensions['spool.speed-test'] === 1
        && Object.keys(current.extensionStatus().enabled).join(',') === 'spool.speed-test'
        && current.extensionStatus().missingHost.indexOf('spool.speed-test') < 0,
        'only implemented exact versions are offered');
    check(Object.keys(wrong.extensionStatus().enabled).length === 0
        && Object.keys(stringVersion.extensionStatus().enabled).length === 0,
        'higher versions and strings do not negotiate version one');
    let probes = 0;
    legacy.pms.host.speedTest = () => { ++probes; return Promise.resolve({}); };
    return fails(() => legacy.source.speedTest({}, legacy.pms.host), 'unsupported_extension')
        .then(() => fails(() => wrong.speedTest({}, legacy.pms.host), 'unsupported_extension'))
        .then(() => fails(() => stringVersion.speedTest({}, legacy.pms.host), 'unsupported_extension'))
        .then(() => check(legacy.pms.calls.length === 0 && probes === 0,
            'unsupported calls cannot inspect libraries or start native probes'));
}

export function run() {
    step = 'connections';
    const ordered = connections([
        { uri: 'https://relay.plex.direct:8443', relay: true },
        { uri: remote, local: false },
        { uri: local, local: true, address: '10.0.0.2', port: 32400 }
    ]);
    check(ordered.map(c => c.uri).join(' ') === [local, 'http://10.0.0.2:32400', remote, 'https://relay.plex.direct:8443']
        .join(' '), 'local first, plain HTTP as a local fallback, relay last');

    const { pms, source } = account();
    check(source.describe().artwork.indexOf(local + '/photo/:/transcode?width={width}') === 0
        && source.describe().artwork.indexOf('X-Plex-Token=server-token') > 0, 'artwork template');

    step = 'search';
    return source.search({ query: 'film', limit: 10 }, pms.host).then(page => {
        check(page.items.length === 2 && page.items[0].id === '10' && page.items[1].type === 'Episode',
            'hubs of media, in order; others dropped');
        const headers = pms.calls[0].options.headers;
        check(headers['X-Plex-Token'] === 'server-token' && headers['X-Plex-Client-Identifier'] === 'device-1'
            && headers.Accept === 'application/json', 'headers');
        const found = page.items[0];
        check(found.resumeTicks === '600000000' && found.runtimeTicks === '72000000000', 'milliseconds become ticks');
        check(found.favorite && !found.played && found.externalIds.Imdb === 'tt1' && found.externalIds.Tmdb === '42',
            'user state and external ids');
        const show = page.items[1];
        check(show.seriesId === '18' && show.seasonId === '19' && show.season === 0 && show.episode === 1
            && show.seriesPosterTag === '/poster' && show.thumbTag === '/still', 'episode shape, season zero kept');
        step = 'browse';
        return source.browse({ parentId: 'section:1', collectionType: 'movies', limit: 1, sortBy: 'DateCreated',
            sortOrder: 'Descending', filters: { genres: ['Drama'], filters: ['IsUnplayed'], years: ['2020'],
                is4K: true, isHdr: true } }, pms.host);
    }).then(page => {
        const url = pms.calls[pms.calls.length - 1].url;
        check(page.total === 3 && page.cursor === '1' && !page.exhausted, 'paging from totalSize');
        check(url.indexOf('genre=55') > 0 && url.indexOf('unwatched=1') > 0 && url.indexOf('year=2020') > 0
            && url.indexOf('sort=addedAt%3Adesc') > 0 && url.indexOf('type=1') > 0, 'filters and sort');
        check(url.indexOf('resolution=4k') > 0 && url.indexOf('hdr=1') > 0, '4K and HDR filters reach Plex');
        check(url.indexOf('X-Plex-Container-Start=0') > 0 && url.indexOf('X-Plex-Container-Size=1') > 0, 'page window');
        return source.browse({ parentId: 'section:1', limit: 5, filters: { genres: ['Western'] } }, pms.host);
    }).then(() => {
        check(pms.calls[pms.calls.length - 1].url.indexOf('genre=-1') > 0, 'a genre the library lacks matches nothing');
        return source.libraries({}, pms.host);
    }).then(result => {
        check(result.items.length === 2 && result.items[0].id === 'section:1' && result.items[1].collectionType === 'tvshows',
            'libraries');
        return Promise.all([source.resume({ limit: 10 }, pms.host), source.nextUp({ limit: 10 }, pms.host)]);
    }).then(([resume, next]) => {
        check(resume.items.length === 1 && resume.items[0].id === '10', 'resume is what is half watched');
        check(next.items.length === 1 && next.items[0].id === '20', 'next up is the next episode');
        step = 'details';
        return source.details({ itemId: '10' }, pms.host);
    }).then(result => {
        const variants = result.item.variants;
        check(variants.length === 2 && variants[0].filename === 'Film.mkv' && variants[1].filename === 'Film.mp4',
            'only file names leave the server');
        check(JSON.stringify(result).indexOf('private') < 0 && variants[0].sizeBytes === undefined, 'no paths, no unsafe sizes');
        check(variants[0].streams[0].rangeType === 'DOVI' && variants[0].streams[2].external, 'streams');
        check(result.item.people[0].id === '1/actor/7' && result.item.people[0].role === 'Lead', 'people');
        return fails(() => source.details({ itemId: '' }, pms.host), 'missing_id');
    }).then(() => {
        step = 'resolve';
        return source.resolve({ itemId: '10', variantId: '101', positionTicks: '0', maxBitrate: 0,
            videoCodecs: ['h264'], restrictVideoCodecs: true }, pms.host);
    }).then(result => {
        check(result.playMethod === 'DirectPlay' && result.url === local + '/library/parts/1001/1/file.mp4'
            && result.variantId === '101', 'the edition asked for plays directly');
        const sidecar = result.streams.find(s => s.external);
        check(sidecar && sidecar.url === local + '/library/streams/12' && sidecar.index >= 10000,
            'a sidecar subtitle comes with its file on the server and an index of its own');
        check(result.headers['X-Plex-Token'] === 'server-token' && result.url.indexOf('server-token') < 0,
            'the token travels in a header');
        check(result.segments.length === 2 && result.segments[0].type === 'Intro' && result.segments[0].startTicks === '10000000'
            && result.segments[1].type === 'Outro', 'intro and credits markers');
        return source.resolve({ itemId: '10', variantId: '100', positionTicks: '600000000', maxBitrate: 20000000,
            maxHeight: 1080, videoCodecs: ['h264'], restrictVideoCodecs: true }, pms.host);
    }).then(result => {
        check(result.playMethod === 'Transcode' && result.url.indexOf(local + '/video/:/transcode/universal/start.m3u8?') === 0,
            'what this device cannot play is transcoded');
        check(result.url.indexOf('mediaIndex=0') > 0 && result.url.indexOf('offset=60') > 0
            && result.url.indexOf('maxVideoBitrate=20000') > 0 && result.url.indexOf('videoResolution=1920x1080') > 0,
            'from the right edition, position and ceiling');
        return fails(() => source.resolve({ itemId: '10', variantId: '999', positionTicks: '0' }, pms.host),
            'selected_variant_unavailable');
    }).then(() => {
        step = 'report';
        return source.report({ event: 'stop', itemId: '10', playSessionId: 's1', playMethod: 'Transcode',
            positionTicks: '600000000' }, pms.host);
    }).then(() => {
        const timeline = pms.calls.filter(c => c.path === '/:/timeline').pop();
        check(timeline.url.indexOf('state=stopped') > 0 && timeline.url.indexOf('time=60000') > 0, 'timeline');
        check(pms.calls[pms.calls.length - 1].path === '/video/:/transcode/universal/stop', 'the transcode stops');
        return fails(() => source.report({ event: 'bogus', itemId: '10' }, pms.host), 'invalid_report');
    }).then(() => {
        step = 'item actions';
        return source.runItemAction({ action: 'playlist', itemId: '10', itemType: 'Movie' }, pms.host);
    }).then(result => {
        check(result.pick && result.pick.playlistType === 'video', 'adding asks where first');
        return source.runItemAction({ action: 'playlist', itemId: '10', itemType: 'Movie', newName: 'Weekend' }, pms.host);
    }).then(result => {
        check(result.message === 'Added to Weekend' && decodeURIComponent(pms.calls[pms.calls.length - 1].url)
            .indexOf('uri=server://machine/com.plexapp.plugins.library/library/metadata/10') > 0, 'a new playlist');
        return source.runItemAction({ action: 'delete', itemId: '10' }, pms.host);
    }).then(result => {
        check(result.pick && result.pick.kind === 'confirm' && !pms.calls.some(c => c.method === 'DELETE'),
            'deleting asks first');
        return source.runItemAction({ action: 'delete', itemId: '10', confirmed: true }, pms.host);
    }).then(result => {
        check(result.changed, 'a confirmed delete reports a change');
        step = 'failover';
        const down = account([local]);
        return down.source.browse({ parentId: 'section:1', limit: 1 }, down.pms.host).then(page => {
            check(page.items.length === 1, 'an unreachable address falls back to the next');
            check(down.pms.events.some(e => e[0] === 'configuration' && e[1].server === remote), 'and remembers it');
            return down.source.browse({ parentId: 'section:1', limit: 1 }, down.pms.host);
        }).then(() => check(down.pms.calls[down.pms.calls.length - 1].origin === remote, 'and keeps using it'));
    }).then(() => {
        step = 'errors';
        return fails(() => source.libraries({}, { device: device, http: () => respond({}, 401) }), 'http_401');
    }).then(() => {
        step = 'sign in';
        const login = createSource({}, { device: device });
        const tv = server({
            'POST https://plex.tv/api/v2/pins': { id: 77, code: 'ABCD' },
            'GET https://plex.tv/api/v2/pins/77': { id: 77, authToken: 'user-token' },
            'GET https://plex.tv/api/v2/user': { id: 5, username: 'ann', title: 'Ann' },
            'GET https://plex.tv/api/v2/resources': [
                { name: 'Player', provides: 'player', clientIdentifier: 'p' },
                { name: 'Home', provides: 'server,player', clientIdentifier: 'machine', accessToken: 'server-token',
                    connections: [{ uri: remote, local: false }, { uri: local, local: true }] }],
            ['GET ' + remote + '/']: { MediaContainer: { machineIdentifier: 'machine' } }
        }, [local]);
        return login.pinStart({}, tv.host).then(pin => {
            check(pin.id === '77' && pin.code === 'ABCD', 'a link code');
            return login.pinPoll({ id: pin.id }, tv.host);
        }).then(result => {
            check(result.user.id === '5' && result.user.name === 'Ann', 'the Plex user');
            check(result.servers.length === 1 && result.servers[0].token === 'server-token'
                && result.servers[0].connections[0].uri === local, 'servers only, local address first');
            const resources = tv.calls.filter(c => c.path === '/api/v2/resources').pop();
            check(resources.options.headers['X-Plex-Token'] === 'user-token', 'plex.tv is asked with the user token');
            return login.connect({ server: result.servers[0], user: result.user }, tv.host);
        }).then(result => {
            check(result.account === '5@machine' && result.group === 'machine' && result.label === 'Ann'
                && result.detail === 'Home', 'account identity');
            check(result.configuration.server === remote && result.configuration.token === 'server-token',
                'the address that answered');
        });
    }).then(() => {
        step = 'notifications';
        const events = [];
        let later = 0;
        const emit = (type, payload) => events.push([type, payload]);
        translate({ NotificationContainer: { type: 'timeline', TimelineEntry: [{ state: 1 }, { state: 5 }] } }, emit,
            () => later++);
        translate({ NotificationContainer: { type: 'timeline', TimelineEntry: [{ state: 1 }] } }, emit, () => later++);
        translate({ NotificationContainer: { type: 'playing', PlaySessionStateNotification: [
            { state: 'stopped', ratingKey: '10' }, { state: 'playing', ratingKey: '11' }] } }, emit, () => later++);
        check(later === 1, 'finished scans become one later change');
        check(events.length === 1 && events[0][1].itemId === '10', 'playback stopped elsewhere changes that item');
    }).then(regressions).then(extensionCompatibility).then(catalogue).then(playQueue).then(remoteContracts).then(home);
}
