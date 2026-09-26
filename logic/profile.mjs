// SPDX-License-Identifier: MPL-2.0
// Match Spool's first-party quality precedence, then express it in Plex's units.
export function maxBitrate(context, local) {
    return context.maxBitrate || (context.unlimitedLocalNetwork && local ? 1000000000 : 0)
        || context.preferredMaxBitrate || context.measuredBitrate || 120000000;
}

export function maxHeight(context) {
    return context.maxHeight || context.preferredMaxHeight || 0;
}

export function playbackPlan(media, context, local, isVideo = true) {
    const part = (media.Part || [])[0] || {};
    const video = (part.Stream || []).find(s => s.streamType === 1);
    const codec = String((video && video.codec) || media.videoCodec || '').toLowerCase();
    const height = Number((video && video.height) || media.height) || 0;
    const bitrate = Number(media.bitrate) * 1000;
    const ceiling = maxBitrate(context, local);
    const heightLimit = maxHeight(context);
    const codecs = (context.videoCodecs || []).map(c => String(c).trim().toLowerCase());
    const decodable = !context.restrictVideoCodecs || !isVideo || codecs.indexOf(codec) >= 0;
    // Missing analysis is not evidence that a constrained source fits.
    const fits = bitrate > 0 && bitrate <= ceiling && (!isVideo || !heightLimit || height > 0 && height <= heightLimit);
    const transcode = Boolean(context.forceTranscode || !fits || !decodable);
    if (transcode && isVideo && context.restrictVideoCodecs && codecs.indexOf('h264') < 0)
        throw new Error('unsupported_transcode_codec');
    const resolutionHeight = heightLimit && height ? Math.min(heightLimit, height) : heightLimit || height;
    const width = Number((video && video.width) || media.width) || 0;
    const resolutionWidth = width && height ? Math.floor(width * resolutionHeight / height / 2) * 2
        : Math.floor(resolutionHeight * 16 / 9 / 2) * 2;
    return {
        ceiling: ceiling, height: heightLimit, isVideo: isVideo,
        direct: !transcode && (!isVideo || !context.preferRemux),
        // Copying an over-limit or unsupported video would silently ignore the choice.
        directStream: transcode ? 0 : 1,
        bitrateKbps: Math.floor(ceiling / 1000),
        resolution: resolutionHeight ? Math.max(2, resolutionWidth) + 'x' + resolutionHeight : undefined
    };
}
