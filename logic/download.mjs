// SPDX-License-Identifier: MPL-2.0
import { container } from './items.mjs';
import { playbackPlan } from './profile.mjs';

const endpoint = '/video/:/transcode/universal/';
const denied = value => value === false || value === 0 || value === '0';

// Downloads never enter the playback session map or update a watched timeline.
export function createDownloads(options) {
    function download(args, host) {
        if (args.mode !== 'original' && args.mode !== 'transcoded') throw new Error('invalid_download_mode');
        return Promise.all([options.policy(host), options.request(host, 'GET', options.metadata(args.itemId))])
            .then(([policy, result]) => {
                const raw = (container(result).Metadata || [])[0];
                if (!raw || !['movie', 'episode', 'clip', 'track'].includes(raw.type)) throw new Error('download_unavailable');
                if (denied(policy.allowDownload) || denied(policy.allowSync) || denied(raw.allowDownload))
                    throw new Error('download_permission_denied');
                const media = raw.Media || [];
                const modeLabel = args.mode === 'original' ? 'Original file' : 'Converted file'
                    + (args.maxHeight ? ' · ' + args.maxHeight + 'p' : '')
                    + (args.maxBitrate ? ' · ' + args.maxBitrate / 1000000 + ' Mbps' : '');
                const label = source => [source.videoResolution, source.editionTitle || raw.editionTitle, source.container]
                    .filter(Boolean).join(' · ') || 'Version ' + String(source.id);
                const candidates = args.variantId ? media.filter(source => String(source.id) === args.variantId) : media;
                if (!candidates.length) throw new Error('selected_variant_unavailable');
                if (args.partId && !args.variantId && media.length > 1) throw new Error('selected_variant_unavailable');
                if (!args.partId && (candidates.length > 1 || (candidates[0].Part || []).length > 1)) {
                    const choices = [];
                    for (const source of candidates) {
                        const sourceParts = source.Part || [];
                        sourceParts.forEach((part, index) => choices.push({ variantId: String(source.id), partId: String(part.id),
                            label: label(source) + (sourceParts.length > 1 ? ' · Part ' + (index + 1) + ' of ' + sourceParts.length : ''),
                            unavailable: denied(part.exists) || denied(part.accessible) }));
                    }
                    return { pick: { kind: 'downloadPart', itemId: args.itemId, modeLabel: modeLabel, choices: choices } };
                }
                const mediaIndex = args.variantId ? media.findIndex(source => String(source.id) === args.variantId) : 0;
                const selected = media[mediaIndex];
                if (!selected) throw new Error('selected_variant_unavailable');
                const parts = selected.Part || [];
                const partIndex = args.partId ? parts.findIndex(part => String(part.id) === args.partId) : 0;
                const part = parts[partIndex];
                if (!part || !/^\/library\/parts\//.test(part.key || '') || denied(part.exists) || denied(part.accessible))
                    throw new Error('selected_part_unavailable');
                if (host.isLogEnabled('debug')) host.log('debug', 'Plex download selected',
                    { mode: args.mode, mediaIndex: mediaIndex, partIndex: partIndex, multipart: parts.length > 1 });
                if (args.mode === 'original') {
                    const size = Number(part.size);
                    return { url: options.partUrl(part.key), container: selected.container || part.container || '',
                        headers: options.headers(), size: Number.isSafeInteger(size) && size > 0 ? size : undefined };
                }
                if (raw.type === 'track' || denied(policy.transcoderVideo) || denied(policy.allowVideoTranscode))
                    throw new Error('download_transcode_unavailable');
                const plan = playbackPlan(Object.assign({}, selected, { Part: [part] }),
                    Object.assign({}, args, { forceTranscode: true }), options.local());
                if (plan.bitrateKbps < 1) throw new Error('quality_unavailable');
                const session = 'spool-download-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
                const parameters = { path: options.metadata(args.itemId), mediaIndex: mediaIndex, partIndex: partIndex,
                    protocol: 'http', download: 1, offset: 0, copyts: 1, hasMDE: 1, directPlay: 0,
                    directStream: 0, directStreamAudio: 0, videoQuality: 100, maxVideoBitrate: plan.bitrateKbps,
                    videoResolution: plan.resolution, session: session, 'X-Plex-Session-Identifier': session,
                    'X-Plex-Client-Identifier': options.deviceId, 'X-Plex-Product': 'Spool',
                    'X-Plex-Platform': 'Generic', 'X-Plex-Client-Profile-Name': 'Chrome' };
                if (plan.height) parameters['X-Plex-Client-Profile-Extra'] =
                    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.height&value='
                    + plan.height + '&isRequired=true)';
                return options.request(host, 'GET', endpoint + 'decision', parameters).then(result => {
                    const box = container(result);
                    const output = (((box.Metadata || [])[0] || {}).Media || [])[0];
                    const outputPart = output && (output.Part || [])[0];
                    const video = outputPart && (outputPart.Stream || []).find(stream => Number(stream.streamType) === 1);
                    if (['generalDecisionCode', 'mdeDecisionCode', 'transcodeDecisionCode'].some(key => Number(box[key]) >= 2000)
                        || !video || video.decision !== 'transcode' || outputPart.decision === 'directplay')
                        throw new Error('download_transcode_unavailable');
                    if (Number(output.bitrate) * 1000 > plan.ceiling || plan.height && Number(video.height || output.height) > plan.height)
                        throw new Error('quality_unavailable');
                    if (host.isLogEnabled('debug')) host.log('debug', 'Plex progressive download accepted', { protocol: 'http', container: 'mkv' });
                    return { url: options.server() + endpoint + 'start.mkv?' + options.query(parameters), container: 'mkv',
                        headers: Object.assign(options.headers(), { 'X-Plex-Session-Identifier': session }),
                        cleanup: { session: session } };
                });
            });
    }
    function release(args, host) {
        const session = args.cleanup && args.cleanup.session;
        if (typeof session !== 'string' || !/^spool-download-[a-z0-9]+$/.test(session)) throw new Error('invalid_download_cleanup');
        return options.request(host, 'GET', endpoint + 'stop', { session: session, 'X-Plex-Session-Identifier': session })
            .then(() => ({}), error => { if (String(error.message || error) !== 'http_404') throw error; return {}; });
    }
    return { download: download, downloadRelease: release };
}
