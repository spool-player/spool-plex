// SPDX-License-Identifier: MPL-2.0
// Plex JSON to Spool's normalized shapes (see sdk/provider.d.ts).

const types = {
    movie: 'Movie', show: 'Series', season: 'Season', episode: 'Episode', artist: 'MusicArtist', album: 'MusicAlbum',
    track: 'Audio', collection: 'BoxSet', playlist: 'Playlist', clip: 'Video', photo: 'Photo', photoalbum: 'PhotoAlbum'
};

export const collectionTypes = { movie: 'movies', show: 'tvshows', artist: 'music', photo: 'photos' };

// Plex counts milliseconds; Spool counts 100 ns ticks as decimal strings.
export function ticks(milliseconds) {
    const value = Number(milliseconds);
    return Number.isSafeInteger(value) && value >= 0 && value <= 922337203685477
        ? (value === 0 ? '0' : String(value) + '0000') : undefined;
}

export function milliseconds(ticksValue) {
    if (ticksValue === undefined)
        ticksValue = '0';
    if (typeof ticksValue === 'number' && Number.isSafeInteger(ticksValue))
        ticksValue = String(ticksValue);
    if (typeof ticksValue !== 'string' || !/^(0|[1-9][0-9]*)$/.test(ticksValue)
        || ticksValue.length > 19 || (ticksValue.length === 19 && ticksValue > '9223372036854775807'))
        throw new Error('invalid_position');
    // Divide the exact decimal first. The quotient of any nonnegative int64
    // tick value fits in a safe JS integer; converting before division does not.
    return ticksValue.length <= 4 ? 0 : Number(ticksValue.slice(0, -4));
}

function date(seconds) {
    return Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : '';
}

function key(value) {
    return value === undefined || value === null || value === '' ? undefined : String(value);
}

const guids = { imdb: 'Imdb', tmdb: 'Tmdb', tvdb: 'Tvdb' };
function externalIds(raw) {
    const ids = {};
    for (const guid of raw.Guid || []) {
        const match = /^(imdb|tmdb|tvdb):\/\/([^/?#]+)/i.exec(String(guid.id || ''));
        if (match)
            ids[guids[match[1].toLowerCase()]] = match[2];
    }
    // Older agents expose a single guid instead of Guid[]. TVDb episode
    // paths start with the show's ID, so they are not episode identities.
    const legacy = /^(?:com\.plexapp\.agents\.)?(imdb|themoviedb|thetvdb):\/\/([^/?#]+)(?:[/?#]|$)/i
        .exec(String(raw.guid || ''));
    if (legacy && (raw.type === 'movie' || raw.type === 'show')) {
        const namespace = { imdb: 'Imdb', themoviedb: 'Tmdb', thetvdb: 'Tvdb' }[legacy[1].toLowerCase()];
        if (!ids[namespace])
            ids[namespace] = legacy[2];
    }
    return ids;
}

export function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function range(raw) {
    if (raw.DOVIPresent)
        return 'DOVI';
    return { smpte2084: 'HDR10', 'arib-std-b67': 'HLG' }[raw.colorTrc] || '';
}

export function stream(raw) {
    const type = { 1: 'Video', 2: 'Audio', 3: 'Subtitle' }[raw.streamType];
    const hdr = range(raw);
    return {
        // Sidecar subtitles have no index in the file.
        index: Number.isInteger(raw.index) ? raw.index : -1, type: type, codec: raw.codec || '',
        profile: raw.profile || '', language: raw.languageTag || raw.languageCode || '',
        title: raw.extendedDisplayTitle || raw.displayTitle || raw.title || '',
        width: finiteNumber(raw.width), height: finiteNumber(raw.height), frameRate: finiteNumber(raw.frameRate),
        bitrate: finiteNumber(Number(raw.bitrate) * 1000), bitDepth: finiteNumber(raw.bitDepth), channels: finiteNumber(raw.channels),
        sampleRate: finiteNumber(raw.samplingRate), range: type === 'Video' ? (hdr ? 'HDR' : 'SDR') : '',
        rangeType: type === 'Video' ? hdr || 'SDR' : '', default: Boolean(raw.default), forced: Boolean(raw.forced),
        external: Boolean(raw.key), interlaced: raw.scanType === 'interlaced'
    };
}

// Only the file name leaves the server: full paths reveal its layout.
function variant(raw) {
    const part = (raw.Part || [])[0] || {};
    const size = typeof part.size === 'string' && /^(0|[1-9][0-9]*)$/.test(part.size)
        && (part.size.length < 19 || part.size.length === 19 && part.size <= '9223372036854775807')
        ? part.size : Number.isSafeInteger(part.size) && part.size >= 0 ? String(part.size) : undefined;
    const streams = (part.Stream || []).map(stream).filter(s => s.type);
    const video = streams.find(s => s.type === 'Video');
    // Library rows commonly advertise video analysis only on Media, without
    // detailed Part.Stream entries. Keep that source analysis in the menu.
    if (video) {
        video.width = video.width || finiteNumber(raw.width);
        video.height = video.height || finiteNumber(raw.height);
    } else if (raw.videoCodec || raw.width || raw.height) {
        streams.unshift(stream({ streamType: 1, codec: raw.videoCodec, width: raw.width, height: raw.height }));
    }
    return {
        id: String(raw.id), label: [raw.videoResolution && raw.videoResolution.toUpperCase(), raw.editionTitle]
            .filter(Boolean).join(' · '),
        container: raw.container || part.container || '', filename: String(part.file || '').split(/[\\/]/).pop(),
        sizeBytes: size, bitrate: finiteNumber(Number(raw.bitrate) * 1000),
        runtimeTicks: ticks(raw.duration), streams: streams
    };
}

function people(raw) {
    const section = key(raw.librarySectionID) || '';
    const list = [];
    // A person is a tag within one library: its id says which, and which
    // kind of credit, so their other work can be listed from it.
    for (const [field, type, filter] of [['Director', 'Director', 'director'], ['Writer', 'Writer', 'writer'],
        ['Role', 'Actor', 'actor']]) {
        for (const person of raw[field] || []) {
            if (person.id !== undefined && section)
                list.push({ id: section + '/' + filter + '/' + person.id, name: person.tag || '', type: type,
                    role: person.role || '', imageTag: person.thumb || '' });
        }
    }
    return list;
}

export function item(raw) {
    const id = key(raw.ratingKey);
    if (!id)
        throw new Error('missing_id');
    const type = types[raw.type] || 'Folder';
    const episode = raw.type === 'episode';
    const season = raw.type === 'season';
    const track = raw.type === 'track';
    const leaves = Number(raw.leafCount) || 0;
    const result = {
        id: id, title: raw.title || '', sortName: raw.titleSort || raw.title || '', type: type,
        entryId: typeof raw.playlistItemID === 'string' && raw.playlistItemID
            ? raw.playlistItemID : Number.isSafeInteger(raw.playlistItemID) ? String(raw.playlistItemID) : undefined,
        overview: raw.summary || '', year: raw.year || 0, runtimeTicks: ticks(raw.duration),
        resumeTicks: ticks(raw.viewOffset), favorite: Number(raw.userRating) >= 10,
        played: leaves > 0 ? Number(raw.viewedLeafCount) >= leaves : Number(raw.viewCount) > 0,
        playCount: raw.viewCount || 0, datePlayed: date(raw.lastViewedAt), dateCreated: date(raw.addedAt),
        dateUpdated: date(raw.updatedAt), premiereDate: raw.originallyAvailableAt ? raw.originallyAvailableAt + 'T00:00:00Z' : '',
        childCount: raw.childCount || leaves || 0,
        seriesId: episode ? key(raw.grandparentRatingKey) : season ? key(raw.parentRatingKey) : undefined,
        seriesName: episode ? raw.grandparentTitle || '' : season ? raw.parentTitle || '' : '',
        seasonId: episode ? key(raw.parentRatingKey) : undefined,
        season: episode && Number.isInteger(raw.parentIndex) ? raw.parentIndex : undefined,
        episode: Number.isInteger(raw.index) && (episode || season || track) ? raw.index : undefined,
        album: track ? raw.parentTitle || '' : '', albumId: track ? key(raw.parentRatingKey) : undefined,
        albumArtist: track ? raw.grandparentTitle || '' : raw.type === 'album' ? raw.parentTitle || '' : '',
        posterTag: raw.thumb || '', thumbTag: episode ? raw.thumb || '' : '',
        backdropTag: raw.art || raw.grandparentArt || '',
        logoTag: ((raw.Image || []).find(image => image.type === 'clearLogo') || {}).url || '',
        seriesPosterTag: episode ? raw.grandparentThumb || '' : season ? raw.parentThumb || '' : '',
        albumPosterTag: track ? raw.parentThumb || '' : '',
        genres: (raw.Genre || []).map(genre => genre.tag), studios: raw.studio ? [raw.studio] : [],
        officialRating: raw.contentRating || '', communityRating: finiteNumber(raw.audienceRating || raw.rating),
        criticRating: Math.round(finiteNumber(raw.rating) * 10), externalIds: externalIds(raw)
    };
    const credits = people(raw);
    if (credits.length > 0)
        result.people = credits;
    if (raw.Media)
        result.variants = raw.Media.map(variant);
    return result;
}

export function container(result) {
    return (result && result.MediaContainer) || {};
}

export function page(result, first, limit) {
    const box = container(result);
    const rows = box.Metadata || box.Directory || [];
    const total = Number.isSafeInteger(box.totalSize) ? box.totalSize : null;
    const exhausted = rows.length === 0 || (total !== null ? first + rows.length >= total : rows.length < limit);
    return { items: rows.filter(row => key(row.ratingKey)).map(item), total: total, exhausted: exhausted,
        cursor: exhausted ? null : String(first + rows.length) };
}

// Plex marks intros and credits on the item it describes.
export function segments(raw) {
    const kinds = { intro: 'Intro', credits: 'Outro', commercial: 'Commercial' };
    return ((raw && raw.Marker) || []).filter(marker => kinds[marker.type]).map(marker => ({
        type: kinds[marker.type], startTicks: ticks(marker.startTimeOffset) || '0',
        endTicks: ticks(marker.endTimeOffset) || '0'
    }));
}

// The server advertises BIF indexes on the original media part, not the
// transcoder's output. Never infer an index when the advertised list is empty.
export function trickplay(part, server, headers) {
    if (!part || !/^\d+$/.test(String(part.id)) || typeof part.indexes !== 'string')
        return undefined;
    const indexes = part.indexes.split(',').map(value => value.trim());
    const index = indexes.indexOf('hd') >= 0 ? 'hd' : indexes.indexOf('sd') >= 0 ? 'sd' : '';
    return index ? { format: 'bif', url: server + '/library/parts/' + part.id + '/indexes/' + index
        + '?interval=10000', headers: headers } : undefined;
}
