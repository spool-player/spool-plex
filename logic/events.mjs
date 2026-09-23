// SPDX-License-Identifier: MPL-2.0
// Plex's notification socket, as Spool `changed` events. A library scan
// sends a burst of timeline entries; they become one change a few seconds
// after the burst, rather than one reload each.

// Timeline states: 5 is an item finished processing, 9 one deleted.
const settled = [5, 9];

export function translate(message, emit, later) {
    const box = message.NotificationContainer || {};
    if (box.type === 'timeline') {
        if ((box.TimelineEntry || []).some(e => settled.indexOf(e.state) >= 0 || e.metadataState === 'deleted'))
            later();
    } else if (box.type === 'playing') {
        // Another client stopped playing: its position and watched state moved.
        for (const session of box.PlaySessionStateNotification || []) {
            if (session.state === 'stopped' && session.ratingKey)
                emit('changed', { itemId: String(session.ratingKey) });
        }
    }
}

// Opens the socket and reopens it after a drop, backing off up to a minute.
// Returns a function that closes it for good.
export function connect(host, url, headers) {
    let socket = null;
    let stopped = false;
    let failures = 0;
    let pending = false;
    const later = () => {
        if (pending)
            return;
        pending = true;
        host.delay(5000).then(() => {
            pending = false;
            if (!stopped)
                host.emit('changed', {});
        });
    };
    function open() {
        if (stopped)
            return;
        try {
            socket = host.socket(url, { headers: headers });
        } catch (error) {
            return;
        }
        socket.onopen = () => {
            failures = 0;
        };
        socket.onmessage = text => {
            try {
                translate(JSON.parse(text), host.emit, later);
            } catch (error) {}
        };
        socket.onclose = () => {
            socket = null;
            if (stopped)
                return;
            failures += 1;
            host.delay(Math.min(60, 2 ** Math.min(failures, 6)) * 1000).then(open);
        };
    }
    open();
    return () => {
        stopped = true;
        if (socket)
            socket.close();
    };
}
