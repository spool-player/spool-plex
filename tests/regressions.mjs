// SPDX-License-Identifier: MPL-2.0
import { createSource, connections } from '../logic/provider.mjs';
import { maxBitrate, maxHeight, playbackPlan } from '../logic/profile.mjs';
import { item, milliseconds, page, ticks } from '../logic/items.mjs';

function check(value, message) {
    if (!value)
        throw new Error('regression: ' + message);
}
function fails(operation, expected) {
    return Promise.resolve().then(operation).then(() => { throw new Error('expected ' + expected); }, error => {
        check(error.message === expected, 'expected ' + expected + ', got ' + error.message);
    });
}
function response(box, status) {
    return Promise.resolve({ status: status || 200, body: JSON.stringify({ MediaContainer: box }) });
}
function parameter(url, name) {
    const match = new RegExp('[?&]' + name + '=([^&]*)').exec(url);
    return match ? decodeURIComponent(match[1]) : '';
}
const origin = 'https://server.plex.direct:32400';
const media = { id: 2, bitrate: 40000, container: 'mkv', Part: [{ id: 3, key: '/library/parts/3/1/file.mkv',
    size: 8388608, Stream: [{ streamType: 1, codec: 'hevc', index: 0, width: 3840, height: 2160 }] }] };
const movie = { ratingKey: '1', type: 'movie', title: 'Film', duration: 7200000, Media: [media] };
function fixture(handler, extensions) {
    const host = { device: { id: 'device' }, extensions: extensions, emit: () => {}, delay: () => new Promise(() => {}),
        http: (url, options) => {
            const path = url.slice(url.indexOf('/', 8)).split('?')[0];
            if (path === '/library/metadata/1')
                return response({ Metadata: [movie] });
            return handler(path, url, options);
        } };
    const source = createSource({ server: origin, token: 'secret', serverId: 'machine',
        connections: [{ uri: origin, local: true }] }, host);
    return { source: source, host: host };
}
function decision(bitrate, height, copied) {
    return response({ generalDecisionCode: 1001, Metadata: [{ Media: [{ bitrate: bitrate, Part: [{
        decision: copied ? 'copy' : 'transcode', Stream: [{ streamType: 1, codec: copied ? 'hevc' : 'h264', index: 0,
            height: height, decision: copied ? 'copy' : 'transcode' }] }] }] }] });
}

export function run() {
    check(maxBitrate({ maxBitrate: 3000000, preferredMaxBitrate: 4000000, measuredBitrate: 5000000,
        unlimitedLocalNetwork: true }, true) === 3000000, 'explicit quality wins on an unlimited LAN');
    check(maxBitrate({ preferredMaxBitrate: 4000000, measuredBitrate: 5000000 }, false) === 4000000,
        'standing quality wins over measurement');
    check(maxBitrate({ measuredBitrate: 5000000 }, false) === 5000000, 'automatic quality uses measured ceiling');
    check(maxBitrate({ preferredMaxBitrate: 4000000, unlimitedLocalNetwork: true }, true) === 1000000000,
        'unlimited LAN bypasses only the standing and automatic ceilings');
    check(maxBitrate({ unlimitedLocalNetwork: true, measuredBitrate: 5000000 }, false) === 5000000,
        'a remote connection cannot claim unlimited LAN quality');
    check(maxHeight({ maxHeight: 720, preferredMaxHeight: 2160 }) === 720, 'explicit height overrides settings');
    check(!playbackPlan(media, { measuredBitrate: 5000000 }, false).direct,
        'measured bandwidth below source bitrate cannot direct play');
    check(!playbackPlan({ Part: media.Part }, { maxBitrate: 5000000 }, false).direct,
        'unknown source bitrate does not bypass quality');
    check(!playbackPlan({ bitrate: 4000, videoCodec: 'h264', Part: [{ Stream: [] }] },
        { maxHeight: 720 }, false).direct, 'unknown height does not bypass a resolution cap');
    check(playbackPlan(media, { unlimitedLocalNetwork: true }, true).direct,
        'an unrestricted local original need not transcode');
    check(page({ MediaContainer: { totalSize: 10, Metadata: [] } }, 0, 10).exhausted,
        'an empty stale Plex page cannot generate an infinite paging loop');
    check(connections([{ uri: origin + '/', local: true, address: '::1', port: 32400 },
        { uri: origin, local: true }]).map(c => c.uri).join('|') === origin + '|http://[::1]:32400',
        'IPv6 HTTP fallback is valid and normalized addresses are deduplicated');

    const capped = fixture((path, url) => {
        if (path.endsWith('/decision')) {
            check(parameter(url, 'directStream') === '0', 'copying must not bypass a quality cap');
            check(parameter(url, 'maxVideoBitrate') === '5000', 'bitrate is rounded down to Plex kilobits');
            check(parameter(url, 'videoResolution') === '1280x720', 'explicit height reaches Plex');
            return decision(4500, 720, false);
        }
        throw new Error('unexpected request');
    });
    return capped.source.resolve({ itemId: '1', maxBitrate: 5000999, maxHeight: 720,
        preferredMaxHeight: 2160, unlimitedLocalNetwork: true }, capped.host).then(result => {
        check(result.playMethod === 'Transcode' && result.streams[0].codec === 'h264'
            && result.streams[0].height === 720, 'server output replaces original stream metadata');
        return fails(() => capped.source.resolve({ itemId: '1', forceTranscode: true,
            restrictVideoCodecs: true, videoCodecs: ['av1'] }, capped.host), 'unsupported_transcode_codec');
    }).then(() => {
        const excessive = fixture(() => decision(9000, 1080, false));
        return fails(() => excessive.source.resolve({ itemId: '1', maxBitrate: 5000000 }, excessive.host),
            'quality_unavailable');
    }).then(() => {
        const oversized = fixture(() => decision(4500, 1080, false));
        return fails(() => oversized.source.resolve({ itemId: '1', maxHeight: 720 }, oversized.host),
            'quality_unavailable');
    }).then(() => {
        const denied = fixture(() => response({ generalDecisionCode: 2001, transcodeDecisionText: 'Disabled' }));
        return fails(() => denied.source.resolve({ itemId: '1', forceTranscode: true }, denied.host),
            'transcode_unavailable');
    }).then(() => {
        const stopped = [];
        const remux = fixture((path, url) => {
            if (path.endsWith('/decision'))
                return decision(40000, 2160, true);
            if (path === '/:/timeline') {
                check(parameter(url, 'duration') === '7200000', 'timeline includes duration for watched thresholds');
                return response({}, 503);
            }
            if (path.endsWith('/stop')) {
                stopped.push(parameter(url, 'session'));
                return response({});
            }
            throw new Error('unexpected request');
        });
        return remux.source.resolve({ itemId: '1', preferRemux: true }, remux.host).then(result => {
            check(result.playMethod === 'DirectStream', 'a copied video is reported as remux, not transcode');
            return fails(() => remux.source.report({ event: 'stop', itemId: '1', playSessionId: result.playSessionId,
                playMethod: result.playMethod, positionTicks: '50000000' }, remux.host), 'http_503').then(() => {
                check(stopped.length === 1 && stopped[0] === result.playSessionId,
                    'the remux session is released even when its final timeline fails');
            });
        });
    }).then(authenticate).then(browse).then(probe).then(baselineRepairs);
}

function authenticate() {
    const other = 'https://other.plex.direct:32400';
    const host = { device: { id: 'device' }, delay: () => new Promise(() => {}),
        http: url => response({ machineIdentifier: url.startsWith(other) ? 'wrong-server' : 'machine' }) };
    const source = createSource({}, host);
    return source.connect({ user: { id: 'u', name: 'User' }, server: { id: 'machine', token: 'secret',
        connections: [{ uri: other }, { uri: origin }] } }, host).then(account => {
        check(account.configuration.server === origin, 'a different Plex server at an old IP is rejected');
        return source.connect({ user: { id: 'u' }, address: 'plex.example.com/', server: { id: 'machine',
            token: 'secret', connections: [{ uri: origin }] } }, host);
    }).then(account => {
        check(account.configuration.server === 'https://plex.example.com'
            && account.configuration.connections.length === 2,
            'a typed custom address is tried first as HTTPS and kept beside the advertised ones');
        return source.connect({ user: { id: 'u' }, address: other, server: { id: 'machine', token: 'secret',
            connections: [{ uri: origin }] } }, host);
    }).then(account => {
        check(account.configuration.server === origin, 'a typed address answering as another server is refused');
        return fails(() => source.connect({ server: { id: 'machine', token: 'expired',
            connections: [{ uri: origin }] } }, { http: () => response({}, 401), delay: host.delay }), 'server_unreachable');
    });
}

function browse() {
    const libraries = { '1': ['a', 'b', 'c'], '2': ['d', 'e'] };
    const pms = fixture((path, url) => {
        if (path === '/library/sections')
            return response({ Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'movie' }] });
        const key = /\/sections\/(\d+)\/all/.exec(path)[1];
        const first = Number(parameter(url, 'X-Plex-Container-Start'));
        const limit = Number(parameter(url, 'X-Plex-Container-Size'));
        return response({ totalSize: libraries[key].length, Metadata: libraries[key].slice(first, first + limit)
            .map(id => ({ ratingKey: id, type: 'movie', title: id })) });
    });
    const rows = [];
    function next(cursor) {
        return pms.source.browse({ collectionType: 'movies', limit: 2, cursor: cursor }, pms.host).then(result => {
            rows.push(...result.items.map(i => i.id));
            return result.exhausted ? null : next(result.cursor);
        });
    }
    return next(null).then(() => check(rows.join(',') === 'a,b,c,d,e', 'paging across libraries loses no matches'));
}

function probe() {
    let endpoint;
    const pms = fixture(path => {
        if (path === '/library/sections')
            return response({ Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'artist' }] });
        if (path === '/library/sections/1/all')
            return response({ Metadata: [{ Media: [{ Part: [{ key: '/library/parts/tiny/file', size: 4096 },
                { key: '/library/parts/offline/file', size: 8388608, accessible: false }] }] }] });
        if (path === '/library/sections/2/all')
            return response({ Metadata: [movie] });
        throw new Error('a speed test must not create a playback session');
    }, { 'spool.speed-test': 1 });
    pms.host.speedTest = value => {
        endpoint = value;
        return Promise.resolve({ bitrate: 18000000, parallelRequests: 2 });
    };
    return pms.source.speedTest({}, pms.host).then(() => {
        check(endpoint.range === true && endpoint.url === origin + media.Part[0].key
            && endpoint.headers['X-Plex-Token'] === 'secret', 'probe skips tiny/offline files and ranges real media natively');
        const empty = fixture(() => response({ Directory: [{ key: '3', type: 'photo' }] }), { 'spool.speed-test': 1 });
        return fails(() => empty.source.speedTest({}, empty.host), 'speed_test_unavailable');
    });
}

function baselineRepairs() {
    const entries = [0, 'opaque/second:entry'].map(entry =>
        item({ ratingKey: '1', type: 'movie', playlistItemID: entry }));
    check(entries[0].id === entries[1].id && entries[0].entryId === '0'
        && entries[1].entryId === 'opaque/second:entry', 'duplicate media keeps distinct playlist occurrence identities');
    check(item({ ratingKey: '1', type: 'movie' }).entryId === undefined, 'ordinary media has no invented entry identity');
    check(milliseconds('9007199254749999') === 900719925474,
        'decimal division floors a value that Number would round across a millisecond boundary');
    check(milliseconds('9223372036854775807') === 922337203685477,
        'int64 upper boundary has a safe integer millisecond quotient');
    check(milliseconds('9999') === 0 && milliseconds('10000') === 1, 'sub-millisecond remainder is floored');
    check(ticks(9007199254741) === '90071992547410000', 'incoming milliseconds become exact decimal ticks too');
    const calls = [];
    const host = { device: { id: 'device' }, http: (url, options) => {
        calls.push({ url: url, options: options });
        if (url.indexOf('/library/metadata/1?') >= 0)
            return response({ Metadata: [movie] });
        if (url.indexOf('/decision?') >= 0)
            return decision(4000, 720, false);
        return response({});
    } };
    const source = createSource({ server: origin, token: 'secret', serverId: 'machine' }, host);
    const decimal = '9007199254749999';
    return source.resolve({ itemId: '1', forceTranscode: true, positionTicks: decimal }, host).then(result => {
        check(parameter(result.url, 'offset') === '900719925', 'resolve uses exact milliseconds before converting to seconds');
        return ['start', 'progress', 'stop'].reduce((pending, event) => pending.then(() =>
            source.report({ event: event, itemId: '1', positionTicks: decimal }, host).then(() => {
                check(parameter(calls[calls.length - 1].url, 'time') === '900719925474',
                    event + ' reports the floored decimal position, never the rounded Number');
            })), Promise.resolve());
    }).then(() => source.progress({ itemId: '1', positionTicks: '9223372036854775807' }, host)).then(() => {
        check(parameter(calls[calls.length - 1].url, 'time') === '922337203685477',
            'resume writes preserve the largest signed64 tick position');
        const count = calls.length;
        return ['-1', '', '1.5', '1e3', ' 1', '+1', '01', '9223372036854775808', null, 9007199254740992]
            .reduce((pending, invalid) => pending.then(() =>
                fails(() => source.resolve({ itemId: '1', positionTicks: invalid }, host), 'invalid_position')
                    .then(() => fails(() => source.report({ event: 'start', itemId: '1', positionTicks: invalid }, host),
                        'invalid_position'))
                    .then(() => fails(() => source.progress({ itemId: '1', positionTicks: invalid }, host),
                        'invalid_position'))), Promise.resolve()).then(() =>
                check(calls.length === count, 'invalid positions fail before any metadata or playback HTTP'));
    });
}
