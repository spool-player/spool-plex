// SPDX-License-Identifier: MPL-2.0
// Stateful protocol fixtures, not evidence of support on a live PMS server.
import { createPlayQueueReporter } from '../logic/play-queue.mjs';

function check(value, message) {
    if (!value) throw new Error('play queue: ' + message);
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise: promise, resolve: resolve };
}
function snapshot(revision, ids, entries) {
    return { revision: revision, items: ids.map((id, i) => ({ itemId: String(id), mediaType: 'video',
        entryId: entries ? entries[i] : undefined })) };
}
function fixture(settings) {
    const config = settings || {};
    const calls = [];
    const events = [];
    const waiting = new Map();
    let rows = [];
    let serial = 100;
    let inFlight = 0;
    let maximumInFlight = 0;
    let held = null;
    let hold = null;
    const result = () => {
        const data = { playQueueID: '7', size: rows.length };
        // Actual PMS empty readback omits count and Metadata, rather than
        // returning the zero/empty-array values the old fixture invented.
        if (rows.length) {
            if (!config.omitTotalCount) data.playQueueTotalCount = rows.length;
            data.Metadata = rows.map(row => Object.assign({}, row));
        }
        if (config.zeroWindowSize) data.size = 0;
        return { MediaContainer: data };
    };
    const add = ids => ids.map(id => ({ ratingKey: id, playQueueItemID: String(++serial) }));
    const parseIds = uri => uri.indexOf('library:///directory/') === 0
        ? decodeURIComponent(uri.slice('library:///directory/'.length)).slice('/library/metadata/'.length).split(',')
        : [uri.slice(uri.lastIndexOf('/') + 1)];
    function dispatch(method, path, parameters) {
        if (method === 'POST' && path === '/playQueues') {
            if (config.createError) throw new Error(config.createError);
            const ids = parseIds(parameters.uri);
            check(ids.length <= 50, 'creation is bounded to 50 IDs');
            rows = add(ids);
            if (config.reverseCreate) rows.reverse();
            return result();
        }
        if (method === 'GET' && path === '/playQueues/7') {
            const answer = result();
            if (config.duplicateOccurrence && answer.MediaContainer.Metadata.length > 1)
                answer.MediaContainer.Metadata[1].playQueueItemID = answer.MediaContainer.Metadata[0].playQueueItemID;
            return answer;
        }
        if (method === 'GET' && path.indexOf('/library/metadata/') === 0) {
            const ids = path.slice('/library/metadata/'.length).split(',');
            check(ids.length <= 50, 'metadata lookup is batched to at most 50 unique IDs');
            check(new Set(ids).size === ids.length, 'metadata fetch avoids duplicate lookups');
            return { MediaContainer: { Metadata: ids.map(id => ({ ratingKey: id, librarySectionID: '3' })) } };
        }
        if (method === 'GET' && path === '/library/sections')
            return { MediaContainer: { Directory: [{ key: '3', uuid: 'section-uuid' }] } };
        if (method === 'PUT' && path === '/playQueues/7') {
            const bulk = parameters.uri.indexOf('library:///directory/') === 0;
            const ids = parseIds(parameters.uri);
            check(!bulk || ids.length <= 50, 'bulk append is bounded to 50 IDs');
            check(parameters.next === 0, 'append does not request play-next');
            if (bulk && config.rejectBulk) throw new Error('http_400');
            if (config.appendErrorBefore) throw new Error(config.appendErrorBefore);
            if (!bulk) check(parameters.uri.indexOf('library://section-uuid/item/library/metadata/') === 0,
                'single append uses the library UUID URI');
            const inserted = add(config.partialAppend ? ids.slice(0, 1) : ids);
            if (config.upNext) rows.splice(1, 0, ...inserted);
            else rows = rows.concat(inserted);
            if (config.appendErrorAfter) throw new Error(config.appendErrorAfter);
            return result();
        }
        const match = /^\/playQueues\/7\/items\/(\d+)(\/move)?$/.exec(path);
        if (match) {
            const offset = rows.findIndex(row => row.playQueueItemID === match[1]);
            check(offset >= 0, 'mutation targets an existing occurrence');
            const row = rows.splice(offset, 1)[0];
            if (match[2]) {
                check(method === 'PUT', 'move uses PUT');
                const after = parameters.after === undefined ? -1 : rows.findIndex(candidate => candidate.playQueueItemID === parameters.after);
                check(parameters.after === undefined || after >= 0, 'move anchor is an occurrence');
                rows.splice(after + 1, 0, row);
            } else check(method === 'DELETE', 'remove uses DELETE');
            return result();
        }
        throw new Error('unexpected_request');
    }
    const reporter = createPlayQueueReporter({
        host: { extensions: { 'spool.playback-queue-reporting': 1 }, emit: (name, event) => {
            check(name === 'playbackQueueStatus' && Object.keys(event).sort().join(',') === 'revision,state',
                'queue events expose no credentials or server errors');
            events.push(event);
            if (event.state !== 'preparing' && waiting.has(event.revision)) {
                waiting.get(event.revision).resolve(event.state);
                waiting.delete(event.revision);
            }
        } },
        baseUrlLength: () => 40,
        request: (method, path, parameters) => {
            calls.push({ method: method, path: path, parameters: parameters });
            ++inFlight;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            return Promise.resolve().then(() => {
                const answer = dispatch(method, path, parameters);
                if (hold && hold(method, path)) {
                    const gate = deferred();
                    hold = null;
                    held.resolve(() => gate.resolve(answer));
                    return gate.promise;
                }
                return answer;
            }).then(answer => { --inFlight; return answer; }, error => { --inFlight; throw error; });
        }
    });
    return { reporter: reporter, calls: calls, events: events, rows: () => rows,
        maximumInFlight: () => maximumInFlight,
        hold: predicate => { hold = predicate; held = deferred(); return held.promise; },
        update: (value, index) => {
            const done = deferred();
            waiting.set(value.revision, done);
            const returned = reporter.update(value, index === undefined ? 0 : index);
            check(returned === undefined, 'report never awaits reconciliation');
            return done.promise;
        }
    };
}

function deltas() {
    const f = fixture({ upNext: true });
    let first;
    let third;
    return f.update(snapshot('a', [1, 1, 2], ['first', 'second', 'third']), 1).then(state => {
        check(state === 'ready', 'duplicates are represented');
        first = f.rows()[0].playQueueItemID;
        third = f.rows()[2].playQueueItemID;
        check(f.reporter.timeline('1').playQueueItemID === f.rows()[1].playQueueItemID, 'timeline selects the exact duplicate');
        return f.update(snapshot('b', [1, 2], ['first', 'third']));
    }).then(state => {
        check(state === 'ready' && f.rows()[0].playQueueItemID === first, 'removing second duplicate retains first');
        check(f.rows()[1].playQueueItemID === third, 'unaffected occurrence survives removal');
        return f.update(snapshot('c', [2, 1, 3], ['third', 'first', 'fourth']));
    }).then(state => {
        check(state === 'ready' && f.rows().map(row => row.ratingKey).join(',') === '2,1,3', 'append and move match desired order');
        check(f.rows()[0].playQueueItemID === third && f.rows()[1].playQueueItemID === first, 'moves retain occurrence identity');
        const before = f.calls.length;
        f.reporter.update(undefined, 1);
        f.reporter.update(snapshot('c', [2, 1, 3], ['third', 'first', 'fourth']), 1);
        check(f.calls.length === before && f.reporter.timeline('1').playQueueItemID === first, 'progress only updates timeline index');
        check(!f.reporter.timeline('2').playQueueID, 'stale item/index never publishes another occurrence');
        check(f.calls.filter(call => call.method === 'POST').length === 1, 'revision deltas reuse the PMS queue');
        return f.update(snapshot('empty', []));
    }).then(state => {
        check(state === 'ready' && f.rows().length === 0, 'empty revision removes all entries');
        check(f.maximumInFlight() <= 2, 'requests remain bounded');
        return f.update(snapshot('single', [4]));
    }).then(state => {
        check(state === 'ready' && f.reporter.timeline('4').playQueueItemID === f.rows()[0].playQueueItemID,
            'an acknowledged empty PMS queue can be populated again');
        return f.update(snapshot('replacement', [5]));
    }).then(state => {
        check(state === 'ready' && f.rows().length === 1 && f.rows()[0].ratingKey === '5'
            && f.reporter.timeline('5').playQueueItemID === f.rows()[0].playQueueItemID,
            'switching singleton movies reconciles through the real empty PMS response');
        check(f.calls.filter(call => call.method === 'POST').length === 1,
            'singleton replacement preserves the source queue rather than creating another');
    });
}
function fallback() {
    const f = fixture({ rejectBulk: true });
    const ids = Array.from({ length: 153 }, (_, i) => i + 1);
    return f.update(snapshot('large', ids)).then(state => {
        check(state === 'ready' && f.rows().map(row => Number(row.ratingKey)).join(',') === ids.join(','), 'single fallback reconstructs the entire queue');
        const bulk = f.calls.filter(call => call.method === 'PUT' && call.parameters.uri
            && call.parameters.uri.indexOf('library:///directory/') === 0);
        check(bulk.length === 1, 'rejected bulk capability is cached for the source');
        const batches = f.calls.filter(call => call.path.indexOf('/library/metadata/') === 0);
        check(batches.map(call => call.path.split('/').pop().split(',').length).join(',') === '50,50,3',
            'single fallback resolves library UUIDs in batches, never per item');
        check(f.maximumInFlight() <= 2, 'large reconciliation bounds concurrency');
        return f.update(snapshot('append', ids.concat([154])));
    }).then(state => {
        check(state === 'ready', 'cached single append remains usable');
        check(f.calls.filter(call => call.method === 'POST').length === 1, 'large append does not recreate queue');
    });
}
function uncertain() {
    const applied = fixture({ appendErrorAfter: 'network_error' });
    return applied.update(snapshot('base', [1])).then(() => applied.update(snapshot('applied', [1, 2])))
        .then(state => {
            check(state === 'ready' && applied.rows().length === 2, 'applied uncertain mutation is acknowledged only by read-back');
            check(applied.calls.filter(call => call.method === 'PUT').length === 1, 'uncertain append is not duplicated');
            const rejected = fixture({ appendErrorBefore: 'network_error' });
            return rejected.update(snapshot('base', [1])).then(() => rejected.update(snapshot('uncertain', [1, 2])))
                .then(answer => {
                    check(answer === 'unavailable' && !rejected.reporter.timeline('1').playQueueID,
                        'unapplied uncertain mutation has no misleading handle');
                    check(rejected.calls.filter(call => call.method === 'PUT').length === 1, 'network error cannot trigger single fallback');
                });
        }).then(() => {
            const partial = fixture({ partialAppend: true, appendErrorAfter: 'http_400' });
            return partial.update(snapshot('base', [1])).then(() => partial.update(snapshot('partial', [1, 2, 3])))
                .then(state => {
                    check(state === 'unavailable' && partial.calls.filter(call => call.method === 'PUT').length === 1,
                        'partial application never retries the whole batch');
                });
        }).then(() => {
            const unknown = fixture({ createError: 'network_error' });
            return unknown.update(snapshot('create', [1])).then(() => unknown.update(snapshot('retry', [1, 2])))
                .then(state => {
                    check(state === 'unavailable' && unknown.calls.filter(call => call.method === 'POST').length === 1,
                        'unidentified uncertain creation is not blindly repeated');
                });
        });
}
function cancellation() {
    const f = fixture();
    const held = f.hold(method => method === 'POST');
    f.update(snapshot('old', [1, 2]));
    return held.then(release => {
        const discarded = f.update(snapshot('intermediate', [4]));
        void discarded;
        const completed = f.update(snapshot('latest', [3, 2]));
        check(!f.reporter.timeline('1').playQueueID, 'preparing generation cannot publish an old handle');
        release();
        return completed;
    }).then(state => {
        check(state === 'ready' && f.rows().map(row => row.ratingKey).join(',') === '3,2', 'newest revision reconciles the acknowledged stale create');
        check(!f.events.some(event => event.state === 'ready' && event.revision !== 'latest'), 'stale generations cannot publish');
        check(!f.events.some(event => event.revision === 'intermediate'), 'pending revisions are coalesced');
        const heldMove = f.hold((method, path) => method === 'PUT' && /\/move$/.test(path));
        f.update(snapshot('stopped', [2, 3]));
        return heldMove;
    }).then(release => {
        f.reporter.stop();
        release();
        return f.update(snapshot('restart', [3, 2]));
    }).then(state => {
        check(state === 'ready' && f.reporter.timeline('3').playQueueID === '7', 'restart reuses and reads back the source queue');
        check(!f.events.some(event => event.revision === 'stopped' && event.state === 'ready'), 'stop fences late completion');
        check(f.maximumInFlight() <= 2, 'coalescing never starts overlapping mutation jobs');
        const firstId = f.rows()[0].playQueueItemID;
        const heldRemoval = f.hold((method, path) => method === 'DELETE'
            && path === '/playQueues/7/items/' + firstId);
        f.update(snapshot('discarded-empty', []));
        return heldRemoval;
    }).then(release => {
        const completed = f.update(snapshot('after-empty', [4, 4], ['first', 'second']), 1);
        release();
        return completed;
    }).then(state => {
        check(state === 'ready' && f.rows().map(row => row.ratingKey).join(',') === '4,4',
            'successor reads an empty queue left by a stale final removal');
        check(f.reporter.timeline('4').playQueueItemID === f.rows()[1].playQueueItemID,
            'successor publishes the selected new duplicate occurrence');
        check(!f.events.some(event => event.revision === 'discarded-empty' && event.state === 'ready'),
            'an empty readback never publishes a stale generation');
        check(f.calls.filter(call => call.method === 'POST').length === 1,
            'stale removal reuses the acknowledged queue');
    });
}
function limitations() {
    const f = fixture();
    const mixed = snapshot('mixed', [1, 2]);
    mixed.items[1].mediaType = 'audio';
    return f.update(mixed).then(state => {
        check(state === 'unavailable' && f.calls.length === 0 && !f.reporter.timeline('1').playQueueID,
            'mixed media types are a nonfatal reporting limitation');
        const wrong = fixture({ reverseCreate: true });
        return wrong.update(snapshot('wrong-order', [1, 2])).then(answer => {
            check(answer === 'unavailable' && !wrong.reporter.timeline('1').playQueueID, 'creation verifies order before publishing');
        });
    }).then(() => {
        const wrong = fixture({ duplicateOccurrence: true });
        return wrong.update(snapshot('wrong-occurrence', [1, 1])).then(state => {
            check(state === 'unavailable', 'duplicate PMS occurrence IDs cannot represent duplicate local entries');
        });
    }).then(() => {
        return [{ omitTotalCount: true }, { omitTotalCount: true, zeroWindowSize: true }]
            .reduce((pending, config, index) => pending.then(() => {
                const incomplete = fixture(config);
                return incomplete.update(snapshot('missing-count-' + index, [1])).then(state => {
                    check(state === 'unavailable' && !incomplete.reporter.timeline('1').playQueueID,
                        'missing count never acknowledges a nonempty or inconsistent window');
                });
            }), Promise.resolve());
    });
}
export function run() {
    return deltas().then(fallback).then(uncertain).then(cancellation).then(limitations);
}
