// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
const origin = 'https://plex.test';
function check(value, message) { if (!value) throw new Error('download contract: ' + message); }
function fails(action, expected) { return Promise.resolve().then(action).then(() => { throw new Error('expected ' + expected); },
    error => check(error.message === expected, 'expected ' + expected + ', received ' + error.message)); }
export function run() {
    let permission = true;
    let decisionCode = 1001;
    let outputBitrate = 4000;
    const calls = [];
    const raw = { ratingKey: '1', type: 'movie', Media: [{ id: 10, container: 'mkv', bitrate: 12000, height: 1080,
        Part: [1, 2].map(id => ({ id: id, key: '/library/parts/' + id + '/file.mkv', size: 1234,
            Stream: [{ streamType: 1, codec: 'hevc', height: 1080 }] })) },
        { id: 11, container: 'mp4', Part: [{ id: 3, key: '/library/parts/3/file.mp4' }] }] };
    const host = { device: { id: 'test' }, isLogEnabled: () => false, log: () => {}, http: (url, options) => {
        calls.push({ url: url, options: options });
        const path = url.slice(origin.length).split('?')[0];
        let box = {};
        if (path === '/') box.allowDownload = permission;
        else if (path === '/library/metadata/1') box.Metadata = [raw];
        else if (path.endsWith('/decision')) box = { generalDecisionCode: decisionCode, Metadata: [{ Media: [{ bitrate: outputBitrate,
            Part: [{ decision: 'transcode', Stream: [{ streamType: 1, decision: 'transcode', codec: 'h264', height: 720 }] }] }] }] };
        else if (!path.endsWith('/stop')) throw new Error('unexpected_path');
        return Promise.resolve({ status: 200, body: JSON.stringify({ MediaContainer: box }) });
    } };
    const source = () => createSource({ server: origin, token: 'secret', serverId: 'machine' }, host);
    const api = source();
    const args = { itemId: '1', mode: 'transcoded', variantId: '10', partId: '2', maxBitrate: 5000000, maxHeight: 720 };
    let cleanup;
    return api.download({ itemId: '1', mode: 'original' }, host).then(result => {
        check(result.pick.choices.length === 3, 'editions and parts are exact choices in one picker');
        return api.download({ itemId: '1', mode: 'original', variantId: '10' }, host);
    }).then(result => {
        check(result.pick.kind === 'downloadPart' && result.pick.choices.length === 2, 'multipart requires explicit part');
        return api.download({ itemId: '1', mode: 'original', variantId: '10', partId: '2' }, host);
    }).then(result => {
        check(result.url === origin + '/library/parts/2/file.mkv?download=1' && result.size === 1234
            && result.headers['X-Plex-Token'] === 'secret', 'original is exact authenticated selected part');
        return fails(() => api.download(Object.assign({}, args, { partId: '99' }), host), 'selected_part_unavailable');
    }).then(() => api.download(args, host)).then(result => {
        cleanup = result.cleanup;
        check(result.container === 'mkv' && result.url.indexOf('/start.mkv?') > 0 && result.url.indexOf('protocol=http') > 0
            && result.url.indexOf('partIndex=1') > 0 && result.url.indexOf('download=1') > 0
            && result.url.indexOf('offset=0') > 0 && !result.url.includes('secret'), 'progressive finite URL binds exact part at media zero');
        return api.downloadRelease({ cleanup: cleanup }, host);
    }).then(() => {
        check(calls[calls.length - 1].url.includes('/stop?session=' + cleanup.session)
            && !calls.some(call => call.url.includes('/:/timeline')), 'cleanup releases only download session without watched reporting');
        decisionCode = 2001;
        return fails(() => api.download(args, host), 'download_transcode_unavailable');
    }).then(() => {
        decisionCode = 1001; outputBitrate = 6000;
        return fails(() => api.download(args, host), 'quality_unavailable');
    }).then(() => {
        permission = false;
        return fails(() => source().download(args, host), 'download_permission_denied');
    });
}
