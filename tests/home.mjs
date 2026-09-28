// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
const origin = 'https://home.example:32400';
const second = 'https://second.example:32400';
const extensions = { 'spool.account-activation': 1, 'spool.remote-targets': 1,
    'spool.http-metadata': 1, 'spool.origin-grants': 1 };
function check(value, message) { if (!value) throw new Error('home: ' + message); }
function fails(action, expected) {
    return Promise.resolve().then(action).then(() => { throw new Error('home: expected ' + expected); },
        error => check(String(error && error.message || error) === expected, 'expected ' + expected + ', got ' + error));
}
function fixture() {
    const state = { offline: false, denied: false, wrongUser: false, wrongServer: false,
        removeServer: false, deferUsers: false, homeStatus: 200, emptyHome: false, profile: {},
        calls: [], events: [], sockets: [], pending: null };
    const json = value => ({ status: 200, body: JSON.stringify(value) });
    const xml = body => ({ status: 200, body: body });
    const host = {
        device: { id: 'home-device', name: 'Home fixture', version: '1' }, extensions: extensions,
        delay: () => new Promise(() => {}),
        emit: (event, payload) => state.events.push({ event: event, payload: payload }),
        socket: (url, options) => { const socket = { url: url, options: options, closed: false,
            close: () => { socket.closed = true; } }; state.sockets.push(socket); return socket; },
        http: (url, options) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
            const token = options.headers['X-Plex-Token'];
            state.calls.push({ url: url, path: path, options: options });
            if (state.offline) return Promise.reject(new Error('network_error'));
            let response;
            if (path === '/api/v2/pins/7') response = json({ authToken: 'full' });
            else if (path === '/api/home/users') {
                check(token === 'full', 'only linked full token enumerates Home');
                if (state.homeStatus !== 200) return Promise.resolve({ status: state.homeStatus, body: '' });
                response = xml(state.emptyHome ? '<MediaContainer/>' :
                    '<MediaContainer><User id="1" title="Parent" protected="1" restricted="0"/>'
                    + '<User id="2" title="Child" protected="1" restricted="1"/></MediaContainer>');
                if (state.deferUsers) return new Promise(resolve => { state.pending = () => resolve(response); });
            } else if (/^\/api\/home\/users\/[12]\/switch$/.test(path)) {
                check(token === 'full', 'only linked token switches Home');
                check(options.method === 'POST' && options.headers['Content-Type'] === 'application/x-www-form-urlencoded',
                    'Home switch uses a form POST');
                check(url.indexOf('pin=') < 0, 'PIN never enters URLs');
                if (options.body !== 'pin=1234') response = { status: 401, body: '' };
                else {
                    const id = path.split('/')[4];
                    response = xml('<user id="' + id + '" authenticationToken="' + (id === '1' ? 'full' : 'member') + '"/>');
                }
            } else if (path === '/api/v2/user') {
                check(token === 'full' || token === 'member', 'PMS tokens never authenticate Plex.tv');
                response = state.denied ? { status: 401, body: '' }
                    : json(Object.assign({ id: state.wrongUser ? 99 : token === 'member' ? 2 : 1,
                        title: token === 'member' ? 'Child' : 'Parent', restricted: token === 'member' }, state.profile));
            } else if (path === '/api/v2/resources') {
                check(token === 'member' || token === 'full', 'resources use active identity token');
                response = json(state.removeServer ? [] : [
                    { provides: 'server', clientIdentifier: 'machine', name: 'First', accessToken: token + '-pms',
                        connections: [{ uri: origin, local: true }] },
                    { provides: 'server', clientIdentifier: 'other', name: 'Second', accessToken: token + '-other',
                        connections: [{ uri: second, local: false }] }]);
            } else if (path === '/') {
                check(token === 'member-pms' || token === 'full-pms' || token === 'member-other',
                    'server receives only its resource token');
                response = json({ MediaContainer: { machineIdentifier: state.wrongServer ? 'impostor'
                    : url.indexOf(second) === 0 ? 'other' : 'machine' } });
            } else if (path === '/library/sections') {
                check(token === 'member-pms' || token === 'full-pms', 'catalogue uses refreshed resource token');
                response = json({ MediaContainer: { Directory: [{ key: '1', title: 'Allowed library' }] } });
            } else if (path === '/clients') response = json({ MediaContainer: { Server: [] } });
            else throw new Error('home: unexpected request ' + path);
            return Promise.resolve(response);
        }
    };
    return { host: host, state: state };
}
function config(extra) {
    return Object.assign({ server: origin, connections: [{ uri: origin }], serverId: 'machine',
        token: 'member-pms', linkedAccountToken: 'full', activeAccountToken: 'member',
        homeFamilyId: '1', userId: '2', userName: 'Child', homeProtected: true, homeManaged: true }, extra || {});
}
function args(reason, extra) { return Object.assign({ reason: reason, lastUsed: true }, extra || {}); }

function login() {
    const f = fixture();
    const source = createSource({}, f.host);
    let linked;
    return source.pinPoll({ id: '7' }, f.host).then(result => {
        linked = result.user;
        check(result.homeUsers.map(user => user.id).join(',') === '1,2' && result.servers.length === 0,
            'link presents Home identities before choosing a server');
        return fails(() => source.homeSelect({ user: linked, userId: '2', pin: 'wrong' }, f.host), 'home_authentication_failed');
    }).then(() => source.homeSelect({ user: linked, userId: '2', pin: '1234' }, f.host)).then(result => {
        check(result.user.linkedAccountToken === 'full' && result.user.activeAccountToken === 'member'
            && result.user.homeManaged && result.user.homeFamilyId === '1', 'separate linked/member identity credentials');
        check(result.servers[0].token === 'member-pms', 'resources re-fetched under switched identity');
        return source.connect({ user: result.user, server: result.servers[0] }, f.host);
    }).then(result => {
        check(result.account === '2@machine' && result.configuration.userId === '2', 'new identity gets its own account key');
        check(result.configuration.token === 'member-pms' && result.configuration.linkedAccountToken === 'full'
            && result.configuration.activeAccountToken === 'member' && !Object.prototype.hasOwnProperty.call(result.configuration, 'pin'),
            'only the three credential roles, never PIN, persist');
        const active = createSource(result.configuration, f.host);
        const count = f.state.calls.filter(call => call.path.indexOf('/switch') >= 0).length;
        return active.activate(args('linked'), f.host).then(proof => {
            check(proof.grant.identityId === '2' && !proof.pick
                && f.state.calls.filter(call => call.path.indexOf('/switch') >= 0).length === count,
                'just-completed linking does not repeat the PIN');
            active.signOut();
        });
    });
}
function gate() {
    const f = fixture();
    const source = createSource(config(), f.host);
    check(f.state.calls.length === 0 && f.state.sockets.length === 0 && !source.describe().artwork,
        'create and describe reveal no authenticated artwork or socket before activation');
    check(source.describe().activation.familyId === '1' && source.describe().activation.identityId === '2', 'opaque Home identity');
    return fails(() => source.libraries({}, f.host), 'account_locked')
        .then(() => fails(() => source.remoteTargets({}, f.host), 'account_locked'))
        .then(() => fails(() => source.homeAutomaticSignIn({ enabled: true }, f.host), 'account_locked'))
        .then(() => fails(() => source.homeSelect({}, f.host), 'action_unavailable'))
        .then(() => source.activate(args('startup'), f.host)).then(result => {
            check(result.pick.kind === 'homePin' && !source.describe().artwork && f.state.sockets.length === 0,
                'protected startup asks for PIN and stays private');
            return fails(() => source.activate(args('switch', { answers: { pin: 'wrong', reason: 'linked',
                grant: { identityId: '2' } } }), f.host), 'home_authentication_failed');
        }).then(() => {
            check(f.state.sockets.length === 0 && !source.describe().artwork, 'wrong PIN never unlocks saved tokens');
            return source.activate(args('switch', { answers: { pin: '1234' } }), f.host);
        }).then(result => {
            check(result.grant.identityId === '2' && f.state.sockets.length === 0
                && source.describe().artwork.indexOf('member-pms') >= 0, 'successful PIN activates only matching identity');
            return source.libraries({}, f.host);
        }).then(result => {
            check(result.items[0].title === 'Allowed library' && f.state.sockets.length === 1,
                'ordinary post-commit catalogue request starts authenticated notifications');
            return fails(() => source.homeAutomaticSignIn({ enabled: true }, f.host), 'permission_denied');
        }).then(() => {
            source.signOut();
            check(f.state.sockets[0].closed, 'logout closes authenticated notifications');
            return fails(() => source.libraries({}, f.host), 'account_locked');
        });
}
function family() {
    const f = fixture();
    const source = createSource(config({ server: second, connections: [{ uri: second }], serverId: 'other' }), f.host);
    const grant = { familyId: '1', identityId: '2', activeAccountToken: 'member' };
    return fails(() => source.activate(args('family', { grant: Object.assign({}, grant, { identityId: '1' }) }), f.host),
        'invalid_activation_grant').then(() => source.activate(args('family', { grant: grant }), f.host)).then(() => {
        check(!f.state.calls.some(call => call.path.indexOf('/api/home') === 0), 'same-identity family proof skips another PIN');
        check(f.state.calls.some(call => call.path === '/api/v2/user') && f.state.calls.some(call => call.path === '/api/v2/resources'),
            'family reuse still validates member token and re-fetches resources');
        check(source.describe().artwork.indexOf('member-other') >= 0, 'each server receives its own refreshed resource token');
        source.signOut();
        const denied = fixture();
        denied.state.removeServer = true;
        return fails(() => createSource(config(), denied.host).activate(args('family', { grant: grant }), denied.host), 'home_server_unavailable');
    }).then(() => {
        const wrong = fixture(); wrong.state.wrongUser = true;
        return fails(() => createSource(config(), wrong.host).activate(args('family', { grant: grant }), wrong.host), 'home_identity_mismatch');
    }).then(() => {
        const wrong = fixture(); wrong.state.wrongServer = true;
        return fails(() => createSource(config(), wrong.host).activate(args('family', { grant: grant }), wrong.host), 'home_server_identity_mismatch');
    });
}
function automatic() {
    const f = fixture();
    const source = createSource(config({ userId: '1', userName: 'Parent', homeManaged: false, activeAccountToken: 'full', token: 'full-pms' }), f.host);
    return source.activate(args('linked'), f.host).then(() => {
        source.homeAutomaticSignIn({ enabled: true }, f.host);
        const event = f.state.events.find(row => row.event === 'activationConfiguration');
        check(event.payload.configuration.homeAutomaticSignIn === true, 'regular authenticated account changes the device family option');
        source.signOut();
        const online = createSource(config({ homeAutomaticSignIn: true }), f.host);
        return online.activate(args('startup'), f.host).then(() => {
            check(!f.state.calls.some(call => call.path.indexOf('/switch') >= 0), 'automatic last-used startup skips PIN');
            online.signOut();
            const explicit = createSource(config({ homeAutomaticSignIn: true }), f.host);
            return explicit.activate(args('switch'), f.host).then(result => {
                check(result.pick.kind === 'homePin', 'automatic option never skips explicit protected switch');
                explicit.signOut();
            });
        });
    }).then(() => {
        const notLast = createSource(config({ homeAutomaticSignIn: true }), f.host);
        return notLast.activate(args('startup', { lastUsed: false }), f.host).then(result => {
            check(result.pick.kind === 'homePin', 'automatic option only authorizes last-used startup');
            notLast.signOut();
        });
    }).then(() => {
        f.state.offline = true;
        const offline = createSource(config({ homeAutomaticSignIn: true }), f.host);
        return offline.activate(args('startup'), f.host).then(result => {
            check(result.grant.identityId === '2' && offline.describe().artwork, 'authorized last-used startup may resume offline');
            offline.signOut();
            return fails(() => createSource(config({ homeAutomaticSignIn: true }), f.host).activate(args('switch'), f.host), 'network_error');
        });
    }).then(() => {
        f.state.offline = false; f.state.denied = true;
        return fails(() => createSource(config({ homeAutomaticSignIn: true }), f.host).activate(args('startup'), f.host), 'http_401');
    });
}
function legacyAndCancellation() {
    const f = fixture();
    const legacy = Object.assign({}, f.host); delete legacy.extensions;
    return fails(() => createSource(config(), legacy), 'activation_host_required').then(() => {
        check(f.state.calls.length === 0 && f.state.sockets.length === 0, 'legacy protected configuration fails before authentication');
        const login = createSource({}, legacy);
        return login.pinPoll({ id: '7' }, legacy).then(result => {
            check(!result.homeUsers && result.servers[0].token === 'full-pms', 'ordinary linked login works on old hosts without Home');
            check(!f.state.calls.some(call => call.path.indexOf('/api/home') === 0), 'old host never exposes Home switching');
            return fails(() => login.homeSelect({}, legacy), 'unsupported_extension');
        });
    }).then(() => {
        const pms = createSource({ server: origin, token: 'member-pms', serverId: 'machine' }, f.host);
        return pms.activate(args('startup'), f.host).then(() => {
            const begin = f.state.calls.length;
            return pms.remoteTargets({}, f.host).then(() => {
                check(f.state.calls.slice(begin).every(call => call.url.indexOf('https://plex.tv') !== 0),
                    'PMS-only account never falls back to a linked full token for cloud discovery');
                pms.signOut();
            });
        });
    }).then(() => {
        const pending = fixture(); pending.state.deferUsers = true;
        const source = createSource(config(), pending.host);
        const operation = source.activate(args('switch'), pending.host);
        source.signOut(); pending.state.pending();
        return fails(() => operation, 'cancelled').then(() => check(pending.state.sockets.length === 0,
            'cancelled prepared source cannot resume and open notifications'));
    });
}
function optionalHomeEndpoint() {
    let sequence = Promise.resolve();
    for (const status of [404, 405, 501]) {
        sequence = sequence.then(() => {
            const f = fixture();
            f.state.homeStatus = status;
            const source = createSource({}, f.host);
            return source.pinPoll({ id: '7' }, f.host).then(result => {
                check(!result.homeUsers && !result.user.homeFamilyId && result.servers[0].token === 'full-pms',
                    'ordinary linked accounts retain server login when Home endpoint is unavailable');
                return source.connect({ user: result.user, server: result.servers[0] }, f.host);
            }).then(account => check(account.account === '1@machine' && account.configuration.activeAccountToken === 'full',
                'optional Home absence still completes an ordinary account'));
        });
    }
    for (const profile of [{ home: true }, { homeAdmin: true }, { homeSize: 2 }, { protected: true },
        { restricted: true }, { pin: 'hashed-server-PIN' }]) {
        sequence = sequence.then(() => {
            const f = fixture();
            f.state.homeStatus = 404;
            f.state.profile = profile;
            return fails(() => createSource({}, f.host).pinPoll({ id: '7' }, f.host), 'http_404')
                .then(() => check(!f.state.calls.some(call => call.path === '/api/v2/resources'),
                    'known Home/protected identity is never downgraded to ordinary server login'));
        });
    }
    for (const status of [401, 403, 500]) {
        sequence = sequence.then(() => {
            const f = fixture();
            f.state.homeStatus = status;
            return fails(() => createSource({}, f.host).pinPoll({ id: '7' }, f.host),
                status === 500 ? 'http_500' : 'home_authentication_failed')
                .then(() => check(!f.state.calls.some(call => call.path === '/api/v2/resources'),
                    'Home auth denial or temporary failure is not optional-endpoint absence'));
        });
    }
    return sequence.then(() => {
        const f = fixture();
        f.state.emptyHome = true;
        f.state.profile = { home: true };
        return fails(() => createSource({}, f.host).pinPoll({ id: '7' }, f.host), 'home_identity_mismatch')
            .then(() => check(!f.state.calls.some(call => call.path === '/api/v2/resources'),
                'empty Home roster cannot downgrade an identity already known to belong to Home'));
    }).then(() => {
        const f = fixture();
        f.state.homeStatus = 404;
        return fails(() => createSource(config(), f.host).activate(args('startup'), f.host), 'http_404')
            .then(() => check(f.state.sockets.length === 0, 'configured Home remains locked when enumeration is absent'));
    });
}
export function run() { return optionalHomeEndpoint().then(login).then(gate).then(family).then(automatic).then(legacyAndCancellation); }
