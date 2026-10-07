// SPDX-License-Identifier: MPL-2.0
// Home credentials never authenticate PMS or Companion requests. PINs live only
// in the submitted operation. Core alone owns activation reasons and grants.
import { parseXml } from './xml.mjs';

const truth = value => value === true || value === 1 || value === '1';
const text = value => value === undefined || value === null ? '' : String(value);
const code = error => String(error && error.message || error);
function identity(user) {
    if (!user || !text(user.id)) throw new Error('home_identity_mismatch');
    return { id: text(user.id), name: text(user.title || user.username),
        homeProtected: truth(user.protected), homeManaged: truth(user.restricted), homeAdmin: truth(user.admin) };
}

export function createHome(options) {
    const configuration = options.configuration;
    const enabled = options.extensions['spool.account-activation'] === 1;
    const configured = Boolean(configuration.homeFamilyId);
    const activation = configured ? { familyId: text(configuration.homeFamilyId), identityId: text(configuration.userId) } : null;
    let authenticated = false;
    let automatic = configuration.homeAutomaticSignIn === true;
    let managed = configuration.homeManaged === true;
    let stopped = false;
    function current() { if (stopped) throw new Error('cancelled'); }
    function supported() { if (!enabled) throw new Error('unsupported_extension'); }
    function xml(host, method, path, token, pin) {
        const headers = options.headers(token);
        headers.Accept = 'application/xml';
        const request = { method: method, headers: headers };
        if (method === 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            request.body = 'pin=' + encodeURIComponent(pin || '');
        }
        return host.http('https://plex.tv' + path, request).then(response => {
            current();
            if (response.status === 401 || response.status === 403)
                throw new Error(method === 'POST' ? 'home_authentication_failed' : 'http_401');
            if (response.status < 200 || response.status >= 300) throw new Error('http_' + response.status);
            return parseXml(response.body);
        });
    }
    function users(host, linkedToken) {
        if (!linkedToken) throw new Error('invalid_config');
        return xml(host, 'GET', '/api/home/users', linkedToken).then(root => {
            if (root.name !== 'MediaContainer') throw new Error('invalid_home_response');
            return root.children.filter(node => node.name === 'User').map(node => identity(node.attributes));
        });
    }
    function resources(host, user, activeToken) {
        if (!activeToken) throw new Error('invalid_config');
        return options.tv(host, 'GET', '/api/v2/user', {}, activeToken).then(profile => {
            current();
            if (text(profile.id) !== user.id) throw new Error('home_identity_mismatch');
            if (profile.restricted !== undefined) user.homeManaged = truth(profile.restricted);
            return options.tv(host, 'GET', '/api/v2/resources', { includeHttps: 1, includeRelay: 1 }, activeToken);
        }).then(result => {
            current();
            return { user: Object.assign({}, user, { activeAccountToken: activeToken }),
                servers: options.servers(result) };
        });
    }
    function switchUser(host, linkedToken, user, pin) {
        if (typeof pin !== 'string' || pin.length > 32) throw new Error('invalid_pin');
        return xml(host, 'POST', '/api/home/users/' + encodeURIComponent(user.id) + '/switch', linkedToken, pin)
            .then(root => {
                const switched = root.attributes;
                if (root.name !== 'user' && root.name !== 'User' || text(switched.id) !== user.id
                        || !switched.authenticationToken) throw new Error('home_identity_mismatch');
                return resources(host, user, switched.authenticationToken);
            });
    }
    function grant(activeToken) {
        const proof = { familyId: activation.familyId, identityId: activation.identityId, activeAccountToken: activeToken };
        if (JSON.stringify(proof).length > 4096) throw new Error('invalid_activation_grant');
        return proof;
    }
    function finish(host, result) {
        current();
        // plex.tv lists only the servers shared with this member.
        const target = result.servers.find(server => server.id === configuration.serverId);
        if (!target) throw new Error('permission_denied');
        return options.refreshServer(host, target, result.user.activeAccountToken).then(() => {
            current();
            managed = result.user.homeManaged === true;
            authenticated = true;
            return { grant: grant(result.user.activeAccountToken) };
        });
    }
    return {
        activation: activation,
        protected: configured && configuration.homeProtected === true,
        // Device linking authenticates the full identity just now; old hosts keep
        // this ordinary login, but never enumerate/switch Home identities.
        linked: (host, profile, token) => {
            const user = identity(profile);
            const knownHome = configured || truth(configuration.homeProtected) || truth(configuration.homeManaged)
                || user.homeProtected || user.homeManaged || truth(profile.home) || truth(profile.homeAdmin)
                || Number(profile.homeSize) > 1 || Boolean(profile.pin);
            user.linkedAccountToken = token;
            user.activeAccountToken = token;
            if (!enabled) return resources(host, user, token);
            return users(host, token).then(members => {
                if (!members.length) {
                    if (knownHome) throw new Error('home_identity_mismatch');
                    return resources(host, user, token);
                }
                const linked = members.find(member => member.id === user.id);
                if (!linked) throw new Error('home_identity_mismatch');
                // The Home is named by its administrator, whichever member linked.
                const admin = members.find(member => member.homeAdmin);
                Object.assign(user, linked, { homeFamilyId: admin ? admin.id : user.id });
                return { user: user, homeUsers: members, servers: [] };
            }, error => {
                // Home is optional for an ordinary linked account, but an
                // authorization failure (or known Home identity) never grants
                // permission to bypass its activation policy.
                if (knownHome || !['http_404', 'http_405', 'http_501'].includes(String(error && error.message || error)))
                    throw error;
                return resources(host, user, token);
            });
        },
        select: (args, host) => {
            supported();
            const linked = args.user || {};
            if (!linked.linkedAccountToken || !linked.homeFamilyId) throw new Error('home_relink_required');
            return users(host, linked.linkedAccountToken).then(members => {
                const user = members.find(member => member.id === text(args.userId));
                if (!user) throw new Error('home_identity_mismatch');
                const full = Object.assign({}, user, { homeFamilyId: linked.homeFamilyId,
                    linkedAccountToken: linked.linkedAccountToken });
                return switchUser(host, linked.linkedAccountToken, full, args.pin || '');
            });
        },
        activate: (args, host) => {
            supported();
            current();
            if (!['linked', 'startup', 'switch', 'family'].includes(args.reason) || typeof args.lastUsed !== 'boolean')
                throw new Error('invalid_activation');
            if (!configured) { authenticated = true; return Promise.resolve({}); }
            const cached = args.grant;
            if (cached && (typeof cached !== 'object' || JSON.stringify(cached).length > 4096
                    || cached.familyId !== activation.familyId || cached.identityId !== activation.identityId
                    || typeof cached.activeAccountToken !== 'string' || !cached.activeAccountToken))
                throw new Error('invalid_activation_grant');
            const autoStartup = args.reason === 'startup' && args.lastUsed && automatic;
            const mayReuse = args.reason === 'linked' || autoStartup || args.reason === 'family' && cached;
            const activeToken = args.reason === 'family' && cached ? cached.activeAccountToken : configuration.activeAccountToken;
            const savedUser = { id: activation.identityId, name: configuration.userName || '',
                homeManaged: configuration.homeManaged === true };
            if (mayReuse) {
                return resources(host, savedUser, activeToken).then(result => finish(host, result)).catch(error => {
                    // Only a previously authorized last-used identity may resume
                    // offline. Invalid credentials/identity/permission never do.
                    if (!autoStartup || code(error) !== 'network_error') throw error;
                    if (!activeToken || !configuration.token || !configuration.server) throw error;
                    authenticated = true;
                    return { grant: grant(activeToken) };
                });
            }
            return users(host, configuration.linkedAccountToken).then(members => {
                const member = members.find(user => user.id === activation.identityId);
                if (!member) throw new Error('home_identity_mismatch');
                if (member.homeProtected && (!args.answers || typeof args.answers.pin !== 'string'))
                    return { pick: { kind: 'homePin', title: member.name || configuration.userName || 'Plex Home' } };
                // An unprotected member keeps the token Plex already issued to
                // this device; switching again is only needed once it is rejected.
                const switched = () => switchUser(host, configuration.linkedAccountToken, member,
                    args.answers && args.answers.pin || '').catch(error => {
                    throw new Error(code(error) === 'home_authentication_failed' ? 'invalid_pin' : code(error));
                });
                const resumed = member.homeProtected || !configuration.activeAccountToken ? switched()
                    : resources(host, member, configuration.activeAccountToken)
                        .catch(error => code(error) === 'http_401' ? switched() : Promise.reject(error));
                return resumed.then(result => finish(host, result));
            });
        },
        settings: () => {
            supported();
            if (!authenticated || !configured) return { available: false, relink: !configured };
            return { available: true, writable: !managed, automaticSignIn: automatic };
        },
        setAutomatic: args => {
            supported();
            if (!authenticated || !configured || managed) throw new Error('permission_denied');
            if (typeof args.enabled !== 'boolean') throw new Error('invalid_setting');
            automatic = args.enabled;
            options.emit('activationConfiguration', { configuration: { homeAutomaticSignIn: automatic } });
            return {};
        },
        stop: () => { stopped = true; authenticated = false; }
    };
}
