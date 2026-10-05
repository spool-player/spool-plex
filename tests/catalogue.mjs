// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';

function check(value, message) {
    if (!value)
        throw new Error('catalogue: ' + message);
}
function fails(action, message) {
    return Promise.resolve().then(action).then(() => { throw new Error('expected ' + message); }, error => {
        check(error.message === message, 'expected ' + message + ', got ' + error.message);
    });
}

export function run() {
    const calls = [];
    let policyReads = 0;
    let refuse = false;
    let entries = [
        { ratingKey: '10', playlistItemID: 11, type: 'movie', title: 'First occurrence' },
        { ratingKey: '10', playlistItemID: '12', type: 'movie', title: 'Second occurrence' },
        { ratingKey: '20', playlistItemID: '13', type: 'movie', title: 'Other' }
    ];
    const rows = {
        '10': { ratingKey: '10', type: 'movie', librarySectionID: 1 },
        'p': { ratingKey: 'p', type: 'playlist', playlistType: 'video', smart: 0 },
        'c': { ratingKey: 'c', type: 'collection', librarySectionID: 1, subtype: 'movie', smart: 0, collectionSort: 2 },
        'alpha': { ratingKey: 'alpha', type: 'collection', librarySectionID: 1, smart: 0, collectionSort: 1 },
        'smart': { ratingKey: 'smart', type: 'playlist', smart: 1 },
        'readonly': { ratingKey: 'readonly', type: 'playlist', readOnly: true }
    };
    const host = {
        device: {}, emit: () => {}, extensions: {
            'spool.suggestions': 1, 'spool.item-actions': 1, 'spool.collection-editing': 1
        },
        http: (url, options) => {
            const path = url.slice('http://pms'.length).split('?')[0];
            const method = options.method || 'GET';
            calls.push({ path: path, method: method, url: decodeURIComponent(url) });
            const response = (value, status) => Promise.resolve({ status: status || 200, body: JSON.stringify(value) });
            if (path === '/') {
                ++policyReads;
                return response({ MediaContainer: { allowMediaDeletion: false } });
            }
            if (path === '/hubs')
                return response({ MediaContainer: { Hub: [
                    { type: 'movie', hubIdentifier: 'home.continueWatching', Metadata: [rows['10']] },
                    { type: 'movie', hubIdentifier: 'movie.recommendations', Metadata: [
                        { ratingKey: 'bad', type: 'movie', accessible: false },
                        { ratingKey: 'foreign', type: 'movie', machineIdentifier: 'elsewhere' },
                        rows['10'], rows['10'], { ratingKey: '30', type: 'show' }
                    ] },
                    { type: 'episode', Metadata: [{ ratingKey: 'episode', type: 'episode' }] }
                ] } });
            const id = path.split('/').pop();
            if (method === 'GET' && path.indexOf('/library/metadata/') === 0 && rows[id])
                return response({ MediaContainer: { Metadata: [rows[id]] } });
            if (method === 'GET' && path === '/playlists/p/items')
                return response({ MediaContainer: { totalSize: entries.length, Metadata: entries } });
            if (method === 'GET' && path === '/library/collections/c/children')
                return response({ MediaContainer: { totalSize: 1, Metadata: [rows['10']] } });
            if (method === 'GET' && path === '/library/sections/1/collections')
                return response({ MediaContainer: { Directory: [rows.c,
                    { ratingKey: 'dynamic', type: 'collection', smart: 1 }] } });
            if (method !== 'GET') {
                if (refuse)
                    return response({}, 403);
                if (method === 'DELETE' && path === '/playlists/p/items/12')
                    entries = entries.filter(entry => String(entry.playlistItemID) !== '12');
                return response({});
            }
            return response({}, 404);
        }
    };
    const source = createSource({ server: 'http://pms', serverId: 'machine', token: 'secret' }, host);
    source.describe();
    check(calls.length === 0, 'startup does not fetch optional policy');
    let reads = 0;
    return source.suggestions({ limit: 2 }, host).then(suggestions => {
        check(suggestions.items.map(row => row.id).join(',') === '10,30' && suggestions.exhausted
            && suggestions.cursor === null, 'accessible recommendations preserve hub order and deduplicate');
        return source.itemActions({ itemId: '10' }, host);
    }).then(actions => {
        check(actions.actions.some(row => row.id === 'collection') && !actions.actions.some(row => row.id === 'delete'),
            'collection action exists, known deletion denial hides delete');
        return source.itemActions({ itemId: '10' }, host);
    }).then(() => {
        check(policyReads === 1, 'account policy cached across menu openings');
        return fails(() => source.runItemAction({ action: 'delete', itemId: '10', confirmed: true }, host),
            'permission_denied');
    }).then(() => source.collectionEntries({ containerId: 'p', limit: 10 }, host)).then(page => {
        check(page.items.map(row => row.entryId).join(',') === '11,12,13', 'numeric/string occurrence ids preserved');
        return source.collectionRemove({ containerId: 'p', entryId: '12' }, host);
    }).then(() => source.collectionEntries({ containerId: 'p', limit: 10 }, host)).then(page => {
        check(page.items.map(row => row.entryId).join(',') === '11,13' && page.items[0].id === '10',
            'deleting second duplicate leaves first occurrence');
        reads = calls.filter(call => call.path.endsWith('/items') && call.method === 'GET').length;
        return source.collectionMove({ containerId: 'p', entryId: '13', index: 0, afterEntryId: null }, host);
    }).then(() => {
        check(calls[calls.length - 1].path === '/playlists/p/items/13/move'
            && calls[calls.length - 1].url.indexOf('after=') < 0, 'move to first omits after');
        return source.collectionMove({ containerId: 'p', entryId: '13', index: 1, afterEntryId: '11' }, host);
    }).then(() => {
        check(calls[calls.length - 1].url.endsWith('?after=11'), 'move uses exact preceding occurrence');
        check(calls.filter(call => call.path.endsWith('/items') && call.method === 'GET').length === reads,
            'moves do not fetch all entries to translate an index');
        return source.collectionEntries({ containerId: 'c' }, host);
    }).then(page => {
        check(page.items[0].entryId === '10', 'regular collection identity is member ratingKey');
        return source.collectionMove({ containerId: 'c', entryId: '10', index: 1, afterEntryId: '20' }, host);
    }).then(() => {
        check(calls[calls.length - 1].url.endsWith('/library/collections/c/items/10/move?after=20'),
            'regular collection uses native after endpoint');
        return source.collectionRemove({ containerId: 'c', entryId: '10' }, host);
    }).then(() => {
        check(calls[calls.length - 1].path === '/library/collections/c/items/10', 'collection removal endpoint');
        return source.collectionInfo({ containerId: 'alpha' }, host);
    }).then(info => {
        check(info.moveMode === 'none', 'alphabetical collection does not offer movement');
        return fails(() => source.collectionMove({ containerId: 'alpha', entryId: '10', index: 0, afterEntryId: null }, host),
            'collection_order_unavailable');
    }).then(() => ['smart', 'readonly'].reduce((pending, id) => pending
        .then(() => source.collectionInfo({ containerId: id }, host)).then(info => {
            check(!info.removable, 'read-only list cannot remove');
            return fails(() => source.collectionRemove({ containerId: id, entryId: '10' }, host), 'permission_denied');
        }), Promise.resolve()))
        .then(() => source.runItemAction({ action: 'collection', itemId: '10', newName: 'Films' }, host)).then(() => {
        check(calls[calls.length - 1].method === 'POST'
            && calls[calls.length - 1].url.indexOf('/library/collections?type=1&title=Films&smart=0&sectionId=1') >= 0
            && calls[calls.length - 1].url.indexOf('uri=server://machine/com.plexapp.plugins.library/library/metadata/10') >= 0,
            'collection creation uses section/type and existing server library URI');
        return source.runItemAction({ action: 'collection', itemId: '10', targetId: 'c' }, host);
    }).then(() => {
        check(calls[calls.length - 1].path === '/library/collections/c/items', 'add to regular collection');
        return source.runItemAction({ action: 'renameCollection', itemId: 'c', newName: 'Renamed' }, host);
    }).then(() => {
        check(calls[calls.length - 1].url.indexOf('/library/sections/1/all?type=18&id=c&title.value=Renamed') >= 0,
            'rename edits collection metadata');
        return source.targets({ kind: 'collection', itemId: '10' }, host);
    }).then(targets => {
        check(targets.items.map(row => row.id).join(',') === 'c', 'smart collections not offered as destinations');
        refuse = true;
        return fails(() => source.collectionRemove({ containerId: 'p', entryId: '11' }, host), 'permission_denied');
    }).then(() => source.collectionInfo({ containerId: 'p' }, host)).then(info => {
        check(!info.removable, '403 invalidates policy and disables subsequent editing');
        const legacy = createSource({ server: 'http://pms', token: 'server-token' }, { device: {} });
        const before = calls.length;
        return fails(() => legacy.suggestions({}, host), 'unsupported_extension')
            .then(() => fails(() => legacy.collectionInfo({ containerId: 'p' }, host), 'unsupported_extension'))
            .then(() => fails(() => legacy.runItemAction({ action: 'collection', itemId: '10' }, host), 'unsupported_extension'))
            .then(() => check(calls.length === before, 'unnegotiated extensions never perform HTTP'));
    });
}
