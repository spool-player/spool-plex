// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
const origin = 'https://home.example:32400';
const second = 'https://second.example:32400';
const capabilities = { 'accountActivation': true, 'remoteTargets': true,
    'httpMetadata': true, 'originGrants': true };
function later(hops) { return hops ? Promise.resolve().then(() => later(hops - 1)) : Promise.resolve(); }
function check(value, message) { if (!value) throw new Error('home: ' + message); }
function fails(action, expected) {
    return Promise.resolve().then(action).then(() => { throw new Error('home: expected ' + expected); },
        error => check(String(error && error.message || error) === expected, 'expected ' + expected + ', got ' + error));
}
function fixture() {
    const state = { offline: false, denied: false, wrongUser: false, wrongServer: false,
        removeServer: false, deferUsers: false, homeStatus: 200, serverStatus: 200, switchStatus: 200, emptyHome: false, profile: {},
        linkedAs: 'full', hung: '', staleGuest: false, calls: [], events: [], sockets: [], pending: null };
    const ids = { full: 1, member: 2, guest: 3, guest2: 3 };
    const json = value => ({ status: 200, body: JSON.stringify(value) });
    const xml = body => ({ status: 200, body: body });
    const host = {
        device: { id: 'home-device', name: 'Home fixture', version: '1' }, capabilities: capabilities,
        // Probe deadlines expire only after every answering address has settled.
        delay: () => later(32),
        emit: (event, payload) => state.events.push({ event: event, payload: payload }),
        socket: (url, options) => { const socket = { url: url, options: options, closed: false,
            close: () => { socket.closed = true; } }; state.sockets.push(socket); return socket; },
        http: (url, options) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
            const token = options.headers['X-Plex-Token'];
            state.calls.push({ url: url, path: path, options: options });
            if (state.offline)
                return Promise.reject(new Error('network_error'));
            if (state.hung && url.indexOf(state.hung) === 0) return new Promise(() => {});
            let response;
            if (path === '/api/v2/pins/7') response = json({ authToken: state.linkedAs });
            else if (path === '/api/home/users') {
                check(token === state.linkedAs, 'only linked full token enumerates Home');
                if (state.homeStatus !== 200) return Promise.resolve({ status: state.homeStatus, body: '' });
                response = xml(state.emptyHome ? '<MediaContainer/>' :
                    '<MediaContainer><User id="1" title="Parent" protected="1" restricted="0" admin="1"/>'
                    + '<User id="2" title="Child" protected="1" restricted="1"/>'
                    + '<User id="3" title="Guest" protected="0" restricted="1"/></MediaContainer>');
                if (state.deferUsers) return new Promise(resolve => { state.pending = () => resolve(response); });
            } else if (/^\/api\/home\/users\/[123]\/switch$/.test(path)) {
                check(token === state.linkedAs, 'only linked token switches Home');
                check(options.method === 'POST' && options.headers['Content-Type'] === 'application/x-www-form-urlencoded',
                    'Home switch uses a form POST');
                check(url.indexOf('pin=') < 0, 'PIN never enters URLs');
                const id = path.split('/')[4];
                if (state.switchStatus !== 200) return Promise.resolve({ status: state.switchStatus, body: '' });
                if (options.body !== (id === '3' ? 'pin=' : 'pin=1234')) response = { status: 401, body: '' };
                else response = xml('<user id="' + id + '" authenticationToken="'
                    + { 1: 'full', 2: 'member', 3: state.staleGuest ? 'guest2' : 'guest' }[id] + '"/>');
            } else if (path === '/api/v2/user') {
                check(token in ids, 'PMS tokens never authenticate Plex.tv');
                response = state.denied || state.staleGuest && token === 'guest' ? { status: 401, body: '' }
                    : json(Object.assign({ id: state.wrongUser ? 99 : ids[token],
                        title: token === 'full' ? 'Parent' : 'Child', restricted: token !== 'full' }, state.profile));
            } else if (path === '/api/v2/resources') {
                check(token in ids, 'resources use active identity token');
                response = json(state.removeServer ? [] : [
                    { provides: 'server', clientIdentifier: 'machine', name: 'First', accessToken: token + '-pms',
                        connections: [{ uri: origin, local: true }] },
                    { provides: 'server', clientIdentifier: 'other', name: 'Second', accessToken: token + '-other',
                        connections: [{ uri: second, local: false }] }]);
            } else if (path === '/') {
                check(/^(member|full|guest2?)-(pms|other)$/.test(token), 'server receives only its resource token');
                if (state.serverStatus !== 200)
                    return Promise.resolve({ status: state.serverStatus, body: '' });
                response = json({ MediaContainer: { machineIdentifier: state.wrongServer ? 'impostor'
                    : url.indexOf(second) === 0 ? 'other' : 'machine' } });
            } else if (path === '/library/sections') {
                check(/^(member|full|guest2?)-pms$/.test(token), 'catalogue uses refreshed resource token');
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
    return source.pinPoll({ id: '7' }, f.host).then(result => {
        check(result.homeUsers.map(user => user.id).join(',') === '1,2,3' && result.servers.length === 0,
            'link presents Home identities before choosing a server');
        check(!('linkedAccountToken' in result.user) && !('activeAccountToken' in result.user),
            'linked credentials never enter the QML response');
        return fails(() => source.homeSelect({ userId: '2', pin: 'wrong' }, f.host), 'invalid_pin');
    }).then(() => source.homeSelect({ userId: '2', pin: '1234' }, f.host)).then(result => {
        check(result.user.homeManaged && result.user.homeFamilyId === '1' && !('token' in result.servers[0]),
            'Home/server chooser receives identities, not authentication secrets');
        return source.connect({ serverId: result.servers[0].id }, f.host);
    }).then(result => {
        const saved = f.state.events.filter(row => row.event === 'configuration').pop().payload;
        check(result.account === '2@machine' && saved.userId === '2'
            && saved.homeFamilyId === '1', 'new identity gets its own account key in the admin Home');
        check(!('configuration' in result) && saved.token === 'member-pms' && saved.linkedAccountToken === 'full'
            && saved.activeAccountToken === 'member' && !Object.prototype.hasOwnProperty.call(saved, 'pin'),
            'three credential roles persist through the private host event, never QML or PIN');
        const active = createSource(saved, f.host);
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
                grant: { identityId: '2' } } }), f.host), 'invalid_pin');
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
        return fails(() => createSource(config(), denied.host).activate(args('family', { grant: grant }), denied.host), 'permission_denied');
    }).then(() => {
        const wrong = fixture(); wrong.state.wrongUser = true;
        return fails(() => createSource(config(), wrong.host).activate(args('family', { grant: grant }), wrong.host), 'auth_required');
    }).then(() => {
        const wrong = fixture(); wrong.state.wrongServer = true;
        return fails(() => createSource(config(), wrong.host).activate(args('family', { grant: grant }), wrong.host), 'auth_required');
    }).then(() => {
        const typed = 'https://plex.example.com';
        const remote = fixture(); remote.state.hung = origin;
        const source = createSource(config({ server: origin, connections: [{ uri: origin }, { uri: typed }] }), remote.host);
        return source.activate(args('family', { grant: grant }), remote.host).then(() => {
            check(source.describe().artwork.indexOf(typed) === 0,
                'a typed address plex.tv does not list activates when the preferred listed one never answers');
            source.signOut();
        });
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
function cancellation() {
    const f = fixture();
    return Promise.resolve().then(() => {
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
                check(!result.homeUsers && !result.user.homeFamilyId && result.servers[0].id === 'machine',
                    'ordinary linked accounts retain server login when Home endpoint is unavailable');
                return source.connect({ serverId: result.servers[0].id }, f.host);
            }).then(account => check(account.account === '1@machine'
                && f.state.events.filter(row => row.event === 'configuration').pop().payload.activeAccountToken === 'full',
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
                status === 500 ? 'http_500' : 'http_401')
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
    }).then(() => {
        for (const credentials of [{ token: '' }, { token: undefined }, { userId: '' }]) {
            const f = fixture();
            let rejected = false;
            try { createSource(config(credentials), f.host); }
            catch (error) { rejected = error.message === 'invalid_config'; }
            check(rejected && f.state.calls.length === 0 && f.state.events.length === 0,
                'incomplete saved credentials request reconnect before network or persistence');
        }
        const f = fixture();
        return fails(() => createSource(config({ linkedAccountToken: '' }), f.host)
            .activate(args('switch'), f.host), 'invalid_config').then(() => {
            check(f.state.calls.length === 0 && f.state.events.length === 0,
                'missing linked credential cannot unlock or overwrite the saved account');
        });
    }).then(() => {
        const f = fixture();
        f.state.homeStatus = 401;
        const source = createSource(config(), f.host);
        return fails(() => source.activate(args('switch'), f.host), 'http_401').then(() => {
            check(!source.describe().artwork && f.state.sockets.length === 0 && f.state.events.length === 0,
                'expired linked credential requests reconnect while retaining locked stored credentials');
        });
    }).then(() => {
        const f = fixture();
        f.state.serverStatus = 401;
        const source = createSource({ server: origin, serverId: 'machine', token: 'member-pms' }, f.host);
        return fails(() => source.activate(args('startup'), f.host), 'http_401').then(() => {
            check(f.state.calls.length === 1 && f.state.calls[0].path === '/'
                && !source.describe().artwork && f.state.sockets.length === 0 && f.state.events.length === 0,
                'ordinary saved PMS credentials are verified before publishing an active account');
        });
    }).then(() => {
        const f = fixture();
        const backup = 'https://backup.example:32400';
        f.state.hung = origin;
        const source = createSource({ server: origin, serverId: 'machine', token: 'member-pms',
            connections: [{ uri: origin }, { uri: backup }] }, f.host);
        return source.activate(args('switch'), f.host).then(() => {
            check(source.describe().artwork.indexOf(backup) === 0 && f.state.sockets.length === 0,
                'ordinary activation keeps approved network failover without premature notification sockets');
        });
    });
}
function credentialChain() {
    const f = fixture();
    const login = createSource({}, f.host);
    return login.pinPoll({ id: '7' }, f.host)
        .then(() => login.homeSelect({ userId: '2', pin: '1234' }, f.host))
        .then(result => Promise.all(result.servers.map(server => login.connect({ serverId: server.id }, f.host))))
        .then(() => {
            const saved = f.state.events.filter(row => row.event === 'configuration').map(row => row.payload);
            check(saved[0].token === 'member-pms' && saved[1].token === 'member-other' && saved.every(value =>
                value.linkedAccountToken === 'full' && value.activeAccountToken === 'member' && value.homeFamilyId === '1'),
            'each server keeps its own resource token beside one member and one Home credential');
            f.state.events = [];
            const restarted = createSource(Object.assign({}, saved[1]), f.host);
            return restarted.activate(args('startup'), f.host).then(result => {
                check(result.pick.kind === 'homePin', 'a protected member asks for the PIN again after restart');
                return restarted.activate(args('startup', { answers: { pin: '1234' } }), f.host);
            }).then(() => {
                const written = f.state.events.filter(row => row.event === 'configuration').map(row => row.payload);
                check(written.length > 0 && written.every(value => !('linkedAccountToken' in value)
                    && value.token === 'member-other' && value.activeAccountToken === 'member'),
                'unlocking rewrites only this server and member credentials, never the Home credential');
                restarted.signOut();
            });
        });
}
function unprotectedResume() {
    const f = fixture();
    const saved = config({ userId: '3', userName: 'Guest', homeProtected: false, activeAccountToken: 'guest', token: 'guest-pms' });
    const source = createSource(saved, f.host);
    return source.activate(args('startup'), f.host).then(result => {
        check(result.grant.identityId === '3' && !f.state.calls.some(call => call.path.indexOf('/switch') >= 0),
            'an unprotected member resumes with its own saved credential instead of switching again');
        source.signOut();
        f.state.staleGuest = true;
        f.state.events = [];
        const stale = createSource(saved, f.host);
        return stale.activate(args('switch'), f.host).then(() => {
            const written = f.state.events.find(row => row.event === 'configuration').payload;
            check(written.activeAccountToken === 'guest2' && written.token === 'guest2-pms'
                && !('linkedAccountToken' in written), 'a rejected member credential is renewed by one Home switch');
            stale.signOut();
        });
    }).then(() => {
        const expired = fixture();
        expired.state.staleGuest = true;
        expired.state.switchStatus = 401;
        const locked = createSource(saved, expired.host);
        return fails(() => locked.activate(args('switch'), expired.host), 'http_401').then(() => {
            check(!locked.describe().artwork && expired.state.events.length === 0
                && expired.state.calls.filter(call => call.path.indexOf('/switch') >= 0).length === 1,
                'unprotected Home POST 401 requests reauthentication, never an invalid-PIN loop or owner fallback');
        });
    });
}
function memberLinked() {
    const f = fixture();
    f.state.linkedAs = 'member';
    return createSource({}, f.host).pinPoll({ id: '7' }, f.host).then(result => {
        check(result.user.id === '2' && result.user.homeFamilyId === '1',
            'a member linking this device joins the administrator Home rather than founding another');
    });
}
function setupReuse() {
    const f = fixture();
    const first = createSource({}, f.host);
    let saved;
    return first.pinPoll({ id: '7' }, f.host)
        .then(() => first.homeSelect({ userId: '2', pin: '1234' }, f.host))
        .then(() => first.connect({ serverId: 'machine' }, f.host))
        .then(() => {
            saved = f.state.events.filter(row => row.event === 'configuration').pop().payload;
            const another = createSource({ setupAccount: saved, setupContext: { purpose: 'addProfile' } }, f.host);
            return another.setupResume({}, f.host).then(result => {
                check(result.homeUsers.length === 3 && !('linkedAccountToken' in result.user),
                    'another profile reuses the retained owner link without exposing it');
                return another.homeSelect({ userId: '3', pin: '' }, f.host);
            }).then(() => another.connect({ serverId: 'machine' }, f.host)).then(account => {
                const member = f.state.events.filter(row => row.event === 'configuration').pop().payload;
                check(account.account === '3@machine' && member.activeAccountToken === 'guest'
                    && member.token === 'guest-pms' && member.linkedAccountToken === saved.linkedAccountToken
                    && f.state.calls.filter(call => call.path === '/api/v2/pins/7').length === 1,
                    'two Home profiles keep separate member/PMS credentials after one owner link');
                another.signOut();
                return fails(() => another.setupResume({}, f.host), 'action_unavailable');
            });
        }).then(() => {
            const draft = createSource({ setupAccount: saved }, f.host);
            return draft.setupResume({}, f.host).then(() => draft.homeSelect({ userId: '3', pin: '' }, f.host))
                .then(() => {
                    const count = f.state.events.length;
                    const pending = draft.connect({ serverId: 'machine' }, f.host);
                    draft.setupCancel();
                    return fails(() => pending, 'cancelled').then(() => check(f.state.events.length === count,
                        'cancelled server selection never commits private credentials'));
                });
        });
}
export function run() { return optionalHomeEndpoint().then(login).then(gate).then(family).then(automatic)
    .then(cancellation).then(credentialChain).then(unprotectedResume).then(memberLinked).then(setupReuse); }
