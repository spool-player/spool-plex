// SPDX-License-Identifier: MPL-2.0
// These queues belong to the selected Companion session, not local reporting.
import { directory } from './play-queue.mjs';
import { container } from './items.mjs';
const maximum = 10000;
function fail() { throw new Error('remote_queue_unavailable'); }
function same(a, b) {
    return a.length === b.length && a.every((row, index) => row.id === b[index].id && row.itemId === b[index].itemId);
}
export function decodeQueue(result, expectedId) {
    const box = container(result);
    const id = String(box.playQueueID || '');
    const count = Number(box.playQueueTotalCount);
    const raw = box.Metadata || [];
    if (!/^\d+$/.test(id) || expectedId && id !== expectedId || !Number.isInteger(count)
            || count < 0 || count > maximum || !Array.isArray(raw) || count !== raw.length) fail();
    const seen = new Set();
    const rows = raw.map(value => {
        const entry = String(value.playQueueItemID || '');
        const itemId = String(value.ratingKey || '');
        if (!/^\d+$/.test(entry) || !/^\d+$/.test(itemId) || seen.has(entry)) fail();
        seen.add(entry);
        return { id: entry, itemId: itemId, raw: value };
    });
    return { id: id, rows: rows, version: box.playQueueVersion === undefined ? undefined : String(box.playQueueVersion) };
}
export function createRemoteQueues(options) {
    let bulkAppend = true;
    const uuids = new Map();
    let sections = null;
    // request is bound to one operation and fences target generations before
    // and after every network call; mutations are never automatically retried.
    function read(request, id, own) {
        return request('GET', '/playQueues/' + id,
            { own: own ? 1 : 0, window: maximum, includeBefore: 1, includeAfter: 1 })
            .then(result => decodeQueue(result, id));
    }
    function batch(rows, offset) {
        const result = [];
        while (offset + result.length < rows.length && result.length < 50) {
            const next = result.concat([rows[offset + result.length]]);
            if (options.server().length + encodeURIComponent(directory(next)).length + 256 > 8192) break;
            result.push(rows[offset + result.length]);
        }
        if (!result.length) fail();
        return result;
    }
    function mutate(request, queue, method, path, parameters, own) {
        let error = null;
        return request(method, path, parameters || {}).catch(failure => { error = failure; })
            .then(() => read(request, queue.id, own)).then(fresh => ({ queue: fresh, error: error }));
    }
    function move(request, queue, entryId, index, after, own) {
        const expected = queue.rows.slice();
        const from = expected.findIndex(row => row.id === entryId);
        if (from < 0 || !Number.isInteger(index) || index < 0 || index >= expected.length) fail();
        const row = expected.splice(from, 1)[0];
        if ((index ? expected[index - 1].id : null) !== after) throw new Error('invalid_queue_destination');
        expected.splice(index, 0, row);
        if (from === index) return Promise.resolve(queue);
        return mutate(request, queue, 'PUT', '/playQueues/' + queue.id + '/items/' + entryId + '/move',
            index ? { after: after } : {}, own).then(result => {
            if (!same(result.queue.rows, expected)) throw result.error || new Error('remote_queue_changed');
            return result.queue;
        });
    }
    function remove(request, queue, entryId) {
        const expected = queue.rows.filter(row => row.id !== entryId);
        if (expected.length === queue.rows.length) throw new Error('entry_not_found');
        return mutate(request, queue, 'DELETE', '/playQueues/' + queue.id + '/items/' + entryId, {}, false)
            .then(result => {
                if (!same(result.queue.rows, expected)) throw result.error || new Error('remote_queue_changed');
                return result.queue;
            });
    }
    function metadata(request, ids) {
        const unique = Array.from(new Set(ids));
        const result = new Map();
        function load(offset) {
            if (offset >= unique.length) return Promise.resolve(result);
            const part = unique.slice(offset, offset + 50);
            return request('GET', '/library/metadata/' + part.join(',')).then(answer => {
                const box = container(answer);
                (box.Metadata || []).forEach(raw => {
                    const id = String(raw.ratingKey);
                    if (part.indexOf(id) >= 0) {
                        result.set(id, raw);
                        const uuid = raw.librarySectionUUID || box.librarySectionUUID;
                        if (uuid) uuids.set(id, String(uuid));
                    }
                });
                if (part.some(id => !result.has(id))) throw new Error('item_not_found');
                return load(offset + 50);
            });
        }
        return load(0);
    }
    function singleMetadata(request, rows) {
        const missing = rows.filter(row => !uuids.has(row.itemId));
        if (!missing.length) return Promise.resolve();
        return metadata(request, missing.map(row => row.itemId)).then(raws => {
            if (missing.every(row => uuids.has(row.itemId))) return;
            const load = sections ? Promise.resolve() : request('GET', '/library/sections').then(result => {
                sections = new Map((container(result).Directory || []).map(row => [String(row.key), String(row.uuid || '')]));
            });
            return load.then(() => missing.forEach(row => {
                const uuid = uuids.get(row.itemId) || sections.get(String(raws.get(row.itemId).librarySectionID));
                if (!uuid) fail();
                uuids.set(row.itemId, uuid);
            }));
        });
    }
    function inserted(queue, fresh, added) {
        const previous = new Set(queue.rows.map(row => row.id));
        const retained = fresh.rows.filter(row => previous.has(row.id));
        const extra = fresh.rows.filter(row => !previous.has(row.id));
        if (!same(retained, queue.rows) || extra.length !== added.length
                || !extra.every((row, index) => row.itemId === added[index].itemId)) return null;
        return extra;
    }
    function order(request, queue, expected, own, offset) {
        while (offset < expected.length && queue.rows[offset].id === expected[offset].id) ++offset;
        if (offset >= expected.length) return Promise.resolve(queue);
        return move(request, queue, expected[offset].id, offset, offset ? expected[offset - 1].id : null, own)
            .then(fresh => order(request, fresh, expected, own, offset + 1));
    }
    function append(request, queue, rows, own) {
        if (queue.rows.length + rows.length > maximum) fail();
        function part(current, offset) {
            if (offset >= rows.length) return Promise.resolve(current);
            const added = bulkAppend ? batch(rows, offset) : [rows[offset]];
            const prepare = bulkAppend ? Promise.resolve() : singleMetadata(request, added);
            return prepare.then(() => {
                const uri = bulkAppend ? directory(added) : 'library://' + encodeURIComponent(uuids.get(added[0].itemId))
                    + '/item/library/metadata/' + added[0].itemId;
                return mutate(request, current, 'PUT', '/playQueues/' + current.id, { uri: uri, next: 0 }, own);
            }).then(result => {
                const extra = inserted(current, result.queue, added);
                if (extra) return order(request, result.queue, current.rows.concat(extra), own, 0)
                    .then(fresh => part(fresh, offset + added.length));
                if (bulkAppend && result.error && /^http_(400|404|405|415|422)$/.test(String(result.error.message))
                        && same(current.rows, result.queue.rows)) {
                    bulkAppend = false;
                    return part(result.queue, offset);
                }
                throw result.error || new Error('remote_queue_changed');
            });
        }
        return part(queue, 0);
    }
    function create(request, ids, mediaType) {
        const rows = ids.map(id => ({ itemId: id }));
        const first = batch(rows, 0);
        // The returned handle is required before any retry/reconciliation is
        // possible. A lost creation response fails this user action, not a retry.
        return request('POST', '/playQueues', { type: mediaType, uri: directory(first), shuffle: 0,
            repeat: 0, continuous: 0, includeRelated: 0 }).then(result => {
            const id = String(container(result).playQueueID || '');
            if (!/^\d+$/.test(id)) fail();
            return read(request, id, true);
        }).then(queue => {
            if (queue.rows.length !== first.length || !queue.rows.every((row, i) => row.itemId === first[i].itemId)) fail();
            return append(request, queue, rows.slice(first.length), true);
        });
    }
    return { read: read, create: create, append: append, move: move, remove: remove, metadata: metadata, order: order };
}
