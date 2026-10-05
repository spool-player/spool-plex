// SPDX-License-Identifier: MPL-2.0
// PMS protocol: python-plexapi/plexapi/playqueue.py (create, get, addItem,
// moveItem, removeItem). Directory append is an optimization, verified below;
// the documented library UUID single-item URI remains the fallback.
const maximumItems = 10000;
const maximumUrl = 8192;
const stale = 'queue_generation_changed';

function fail() { throw new Error('queue_unavailable'); }
function text(value) { return value === undefined || value === null ? '' : String(value); }
function box(result) { return result && result.MediaContainer || {}; }
function same(a, b) {
    return a.length === b.length && a.every((row, index) =>
        row.itemId === b[index].itemId && row.pmsId === b[index].pmsId);
}
export function directory(items) {
    return 'library:///directory/' + encodeURIComponent('/library/metadata/' + items.map(row => row.itemId).join(','));
}

/** request MUST use the source host, and MUST NOT retry a mutation at another
 * address. No operation waits for this job. Cancellation fences every request;
 * an already sent mutation is read back before the next generation proceeds.
 * Source teardown cancels the actual native HTTP requests. */
export function createPlayQueueReporter(options) {
    const host = options.host;
    const enabled = host.extensions && host.extensions['spool.playback-queue-reporting'] === 1;
    let generation = 0;
    let desired = null;
    let index = -1;
    let running = false;
    let handled = -1;
    let published = null;
    let queue = null;
    let bulkAppend = true;
    let creationUncertain = false;
    const uuids = new Map();
    let sections = null;

    function check(epoch) {
        if (epoch !== generation || !desired)
            throw new Error(stale);
    }
    function status(snapshot, state) {
        host.emit('playbackQueueStatus', { revision: snapshot.revision, state: state });
    }
    function request(epoch, method, path, parameters) {
        check(epoch);
        const queryLength = Object.keys(parameters || {}).reduce((length, key) =>
            length + encodeURIComponent(key).length + encodeURIComponent(String(parameters[key])).length + 2, 0);
        if ((options.baseUrlLength ? options.baseUrlLength() : 2048) + path.length + queryLength > maximumUrl)
            return Promise.reject(new Error('queue_unavailable'));
        return Promise.resolve().then(() => {
            check(epoch);
            return options.request(method, path, parameters || {});
        });
    }
    function decode(result, previous) {
        const data = box(result);
        const id = text(data.playQueueID);
        const metadata = data.Metadata || [];
        // PMS omits both TotalCount and Metadata after the last occurrence is
        // removed. Only its explicit empty window acknowledges that state;
        // missing counts on a nonempty/truncated window still fail closed.
        const empty = data.playQueueTotalCount === undefined && (data.size === 0 || data.size === '0')
            && Array.isArray(metadata) && metadata.length === 0;
        const count = empty ? 0 : Number(data.playQueueTotalCount);
        if (!/^\d+$/.test(id) || !Number.isInteger(count) || count < 0 || count > maximumItems
                || !Array.isArray(metadata) || metadata.length !== count)
            fail();
        const known = new Map((previous ? previous.rows : []).map(row => [row.pmsId, row]));
        const seen = new Set();
        const rows = metadata.map(row => {
            const pmsId = text(row.playQueueItemID);
            const itemId = text(row.ratingKey);
            if (!/^\d+$/.test(pmsId) || !/^\d+$/.test(itemId) || seen.has(pmsId))
                fail();
            seen.add(pmsId);
            const old = known.get(pmsId);
            return { itemId: itemId, pmsId: pmsId,
                key: old && old.itemId === itemId ? old.key : undefined };
        });
        if (previous && previous.id !== id)
            fail();
        return { id: id, rows: rows, mediaType: previous && previous.mediaType };
    }
    function refresh(epoch) {
        const previous = queue;
        // A full, bounded window is needed to validate all occurrences, not just
        // the currently selected item's default 50-row window. Truncation fails
        // closed instead of publishing a misleading partial handle.
        return request(epoch, 'GET', '/playQueues/' + previous.id,
            { own: 1, window: maximumItems, includeBefore: 1, includeAfter: 1 }).then(result => {
            queue = decode(result, previous);
            check(epoch);
            return queue;
        });
    }
    function chunk(rows, offset) {
        const result = [];
        for (let i = offset; i < rows.length && result.length < 50; ++i) {
            const candidate = result.concat([rows[i]]);
            // Reserve the path, flags and configured base URL, including double
            // encoding of the directory URI as an HTTP query value.
            const budget = maximumUrl - (options.baseUrlLength ? options.baseUrlLength() : 2048) - 256;
            if (encodeURIComponent(directory(candidate)).length > budget)
                break;
            result.push(rows[i]);
        }
        if (!result.length)
            fail();
        return result;
    }
    function create(epoch, snapshot) {
        if (creationUncertain)
            fail();
        const first = chunk(snapshot.items, 0);
        creationUncertain = true;
        return request(epoch, 'POST', '/playQueues', { type: snapshot.mediaType, uri: directory(first),
            shuffle: 0, repeat: 0, continuous: 0, includeRelated: 0 }).then(result => {
            // Retain an acknowledged handle even if the generation changed while
            // POST was in flight: the next revision reads/reconciles it, not POSTs again.
            const id = text(box(result).playQueueID);
            if (!/^\d+$/.test(id))
                fail();
            queue = { id: id, rows: [], mediaType: snapshot.mediaType };
            creationUncertain = false;
            check(epoch);
            return refresh(epoch);
        }, error => {
            // Without a returned queue ID an uncertain POST cannot be read
            // back. Do not create duplicates on later revisions in this source.
            if (/^http_4\d\d$/.test(text(error.message)) || error.message === stale)
                creationUncertain = false;
            throw error;
        }).then(() => {
            if (queue.rows.length !== first.length || !queue.rows.every((row, i) => row.itemId === first[i].itemId))
                fail();
            queue.rows.forEach((row, i) => { row.key = first[i].key; });
        });
    }
    // Read after every mutation, including an HTTP/network error. An uncertain
    // mutation is never blindly reissued. Only an exact expected read-back can
    // acknowledge it; stale generations leave the read to their successor.
    function mutate(epoch, method, path, parameters) {
        let failure = null;
        return request(epoch, method, path, parameters).catch(error => { failure = error; }).then(() => {
            check(epoch);
            return refresh(epoch);
        }).then(() => failure);
    }
    function remove(epoch, row) {
        const expected = queue.rows.filter(candidate => candidate.pmsId !== row.pmsId);
        return mutate(epoch, 'DELETE', '/playQueues/' + queue.id + '/items/' + row.pmsId).then(() => {
            if (!same(queue.rows, expected))
                fail();
        });
    }
    function move(epoch, from, to) {
        const expected = queue.rows.slice();
        const row = expected.splice(from, 1)[0];
        expected.splice(to, 0, row);
        const parameters = to ? { after: expected[to - 1].pmsId } : {};
        return mutate(epoch, 'PUT', '/playQueues/' + queue.id + '/items/' + row.pmsId + '/move', parameters)
            .then(() => { if (!same(queue.rows, expected)) fail(); });
    }
    function metadata(epoch, rows) {
        const missing = Array.from(new Set(rows.map(row => row.itemId))).filter(id => !uuids.has(id));
        function load(offset) {
            if (offset >= missing.length)
                return Promise.resolve();
            const ids = missing.slice(offset, offset + 50);
            return request(epoch, 'GET', '/library/metadata/' + ids.join(',')).then(result => {
                check(epoch);
                const data = box(result);
                const entries = data.Metadata || [];
                const needsSections = entries.some(row => !row.librarySectionUUID && !data.librarySectionUUID);
                const sectionRequest = needsSections && !sections
                    ? request(epoch, 'GET', '/library/sections').then(answer => {
                        check(epoch);
                        sections = new Map((box(answer).Directory || []).map(row => [text(row.key), text(row.uuid)]));
                    }) : Promise.resolve();
                return sectionRequest.then(() => {
                    check(epoch);
                    entries.forEach(row => {
                        const uuid = text(row.librarySectionUUID || data.librarySectionUUID
                            || (sections && sections.get(text(row.librarySectionID || data.librarySectionID))));
                        if (uuid && ids.indexOf(text(row.ratingKey)) >= 0)
                            uuids.set(text(row.ratingKey), uuid);
                    });
                    if (ids.some(id => !uuids.has(id)))
                        fail();
                    return load(offset + 50);
                });
            });
        }
        return load(0);
    }
    function verifyAppend(before, added) {
        const old = new Set(before.map(row => row.pmsId));
        const retained = queue.rows.filter(row => old.has(row.pmsId));
        const inserted = queue.rows.filter(row => !old.has(row.pmsId));
        if (!same(before, retained) || inserted.length !== added.length
                || !inserted.every((row, i) => row.itemId === added[i].itemId))
            return false;
        // PMS may insert in its Up Next region rather than at the physical end.
        // The new occurrence order is verified here; ordered moves below put
        // those exact occurrences in the requested final positions.
        inserted.forEach((row, i) => { row.key = added[i].key; });
        return true;
    }
    function appendSingle(epoch, rows, offset) {
        if (offset >= rows.length)
            return Promise.resolve();
        const row = rows[offset];
        const before = queue.rows.slice();
        const uri = 'library://' + encodeURIComponent(uuids.get(row.itemId)) + '/item/library/metadata/' + row.itemId;
        return mutate(epoch, 'PUT', '/playQueues/' + queue.id, { uri: uri, next: 0 }).then(() => {
            if (!verifyAppend(before, [row]))
                fail();
            return appendSingle(epoch, rows, offset + 1);
        });
    }
    function append(epoch, rows, offset) {
        if (offset >= rows.length)
            return Promise.resolve();
        const batch = chunk(rows, offset);
        if (!bulkAppend)
            return metadata(epoch, rows.slice(offset)).then(() => appendSingle(epoch, rows, offset));
        const before = queue.rows.slice();
        return mutate(epoch, 'PUT', '/playQueues/' + queue.id, { uri: directory(batch), next: 0 }).then(error => {
            if (verifyAppend(before, batch))
                return append(epoch, rows, offset + batch.length);
            // Only explicit unsupported-request responses plus unchanged
            // read-back permit single-item fallback. No retry after timeouts,
            // 5xx, partial application, permission failures, or silent success.
            if (!error || !/^http_(400|404|405|415|422)$/.test(text(error.message)) || !same(before, queue.rows))
                fail();
            bulkAppend = false;
            return metadata(epoch, rows.slice(offset)).then(() => appendSingle(epoch, rows, offset));
        });
    }
    function reconcile(epoch, snapshot) {
        if (!snapshot.items.length && !queue)
            return Promise.resolve();
        const prepare = queue && (!snapshot.items.length || queue.mediaType === snapshot.mediaType)
            ? refresh(epoch) : create(epoch, snapshot);
        return prepare.then(() => {
            check(epoch);
            const wanted = new Set(snapshot.items.map(row => row.key));
            const assigned = new Set(queue.rows.filter(row => wanted.has(row.key)).map(row => row.key));
            const available = new Map();
            queue.rows.forEach(row => {
                if (!row.key) {
                    if (!available.has(row.itemId)) available.set(row.itemId, []);
                    available.get(row.itemId).push(row);
                }
            });
            snapshot.items.forEach(row => {
                const candidates = available.get(row.itemId);
                if (!assigned.has(row.key) && candidates && candidates.length) {
                    candidates.shift().key = row.key;
                    assigned.add(row.key);
                }
            });
            const obsolete = queue.rows.filter(row => !wanted.has(row.key)).reverse();
            function prune(offset) {
                if (offset >= obsolete.length) return Promise.resolve();
                return remove(epoch, obsolete[offset]).then(() => prune(offset + 1));
            }
            return prune(0).then(() => {
                const existing = new Set(queue.rows.map(row => row.key));
                return append(epoch, snapshot.items.filter(row => !existing.has(row.key)), 0);
            });
        }).then(() => {
            function order(offset) {
                check(epoch);
                while (offset < snapshot.items.length && queue.rows[offset]
                        && queue.rows[offset].key === snapshot.items[offset].key)
                    ++offset;
                if (offset === snapshot.items.length) return Promise.resolve();
                const from = queue.rows.findIndex(row => row.key === snapshot.items[offset].key);
                if (from < 0) fail();
                return move(epoch, from, offset).then(() => order(offset + 1));
            }
            return order(0);
        }).then(() => {
            check(epoch);
            if (queue.rows.length !== snapshot.items.length || !queue.rows.every((row, i) =>
                row.itemId === snapshot.items[i].itemId && row.key === snapshot.items[i].key))
                fail();
            published = { revision: snapshot.revision, id: queue.id, rows: queue.rows };
        });
    }
    function pump() {
        if (running || !desired || handled === generation)
            return;
        running = true;
        const epoch = generation;
        const snapshot = desired;
        status(snapshot, 'preparing');
        Promise.resolve().then(() => {
            check(epoch);
            if (!snapshot.valid || (snapshot.items.length && !snapshot.mediaType))
                fail();
            return reconcile(epoch, snapshot);
        }).then(() => {
            check(epoch);
            status(snapshot, 'ready');
        }).catch(() => {
            if (epoch === generation && desired)
                status(snapshot, 'unavailable');
        }).then(() => {
            handled = epoch;
            running = false;
            pump();
        });
    }
    return {
        update: (snapshot, currentIndex) => {
            if (!enabled)
                return;
            if (Number.isInteger(currentIndex)) index = currentIndex;
            if (snapshot && (!desired || desired.revision !== snapshot.revision)) {
                ++generation;
                published = null;
                const counts = new Map();
                let valid = typeof snapshot.revision === 'string' && snapshot.revision.length > 0
                    && snapshot.revision.length <= 256 && Array.isArray(snapshot.items) && snapshot.items.length <= maximumItems;
                const items = valid ? snapshot.items.map(value => {
                    const row = value || {};
                    const itemId = text(row.itemId);
                    const identity = JSON.stringify([itemId, row.entryId === undefined ? null : text(row.entryId)]);
                    const occurrence = counts.get(identity) || 0;
                    counts.set(identity, occurrence + 1);
                    const key = identity + ':' + occurrence;
                    if (!/^\d+$/.test(itemId) || (row.mediaType !== 'audio' && row.mediaType !== 'video'))
                        valid = false;
                    return Object.freeze({ itemId: itemId, key: key, mediaType: row.mediaType });
                }) : [];
                const mediaType = valid && items.length && items.every(row => row.mediaType === items[0].mediaType)
                    ? items[0].mediaType : null;
                desired = Object.freeze({ revision: typeof snapshot.revision === 'string' ? snapshot.revision.slice(0, 256) : '',
                    items: Object.freeze(items), mediaType: mediaType, valid: valid });
                pump();
            }
        },
        timeline: itemId => {
            if (!published || !desired || published.revision !== desired.revision || index < 0
                    || index >= published.rows.length || published.rows[index].itemId !== text(itemId))
                return {};
            return { playQueueID: published.id, playQueueItemID: published.rows[index].pmsId };
        },
        stop: () => {
            ++generation;
            desired = null;
            published = null;
            index = -1;
        }
    };
}
