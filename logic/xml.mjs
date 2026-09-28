// SPDX-License-Identifier: MPL-2.0
// Companion and Plex Home share this deliberately small, bounded XML reader.
// No DTD, external entities, namespace processing, or browser/Node dependency.
function invalid() { throw new Error('invalid_xml'); }
function character(code) {
    return code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff
        || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff;
}
function entities(value) {
    let result = '';
    let offset = 0;
    const builtins = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    while (offset < value.length) {
        const next = value.indexOf('&', offset);
        if (next < 0) return result + value.slice(offset);
        result += value.slice(offset, next);
        const end = value.indexOf(';', next + 1);
        if (end < 0 || end - next > 16) invalid();
        const name = value.slice(next + 1, end);
        if (Object.prototype.hasOwnProperty.call(builtins, name)) result += builtins[name];
        else {
            if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) invalid();
            const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
            if (!character(code)) invalid();
            result += String.fromCodePoint(code);
        }
        offset = end + 1;
    }
    return result;
}

export function parseXml(source) {
    if (typeof source !== 'string' || source.length > 262144) invalid();
    let bytes = 0;
    for (const ch of source) {
        const code = ch.codePointAt(0);
        if (!character(code)) invalid();
        bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
        if (bytes > 262144) invalid();
    }
    let offset = source[0] === '\ufeff' ? 1 : 0;
    let count = 0;
    let root = null;
    const stack = [];
    const whitespace = () => {
        const begin = offset;
        while (offset < source.length && /[\t\r\n ]/.test(source[offset])) ++offset;
        return offset > begin;
    };
    const name = () => {
        const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(source.slice(offset));
        if (!match) invalid();
        offset += match[0].length;
        return match[0];
    };
    // XML declaration is the only processing instruction accepted.
    if (source.slice(offset, offset + 5) === '<?xml') {
        const end = source.indexOf('?>', offset + 5);
        if (end < 0 || !/^<\?xml\s+version\s*=\s*(['"])1\.[01]\1(?:\s+(?:encoding|standalone)\s*=\s*(['"])[A-Za-z0-9._-]+\2)*\s*\?>$/.test(source.slice(offset, end + 2))) invalid();
        offset = end + 2;
    }
    while (offset < source.length) {
        if (source[offset] !== '<') {
            const end = source.indexOf('<', offset);
            const raw = source.slice(offset, end < 0 ? source.length : end);
            if (raw.indexOf(']]>') >= 0) invalid();
            const text = entities(raw);
            if (!stack.length && !/^[\t\r\n ]*$/.test(raw)) invalid();
            if (stack.length) stack[stack.length - 1].text += text;
            offset += raw.length;
        } else if (source.slice(offset, offset + 4) === '<!--') {
            const end = source.indexOf('-->', offset + 4);
            if (end < 0 || source.slice(offset + 4, end).indexOf('--') >= 0
                    || source[end - 1] === '-') invalid();
            offset = end + 3;
        } else if (source.slice(offset, offset + 9) === '<![CDATA[') {
            const end = source.indexOf(']]>', offset + 9);
            if (!stack.length || end < 0) invalid();
            stack[stack.length - 1].text += source.slice(offset + 9, end);
            offset = end + 3;
        } else if (source.slice(offset, offset + 2) === '</') {
            offset += 2;
            const closing = name();
            whitespace();
            if (source[offset++] !== '>' || !stack.length || stack.pop().name !== closing) invalid();
        } else {
            ++offset;
            if (source[offset] === '!' || source[offset] === '?') invalid();
            const node = { name: name(), attributes: Object.create(null), children: [], text: '' };
            if (++count > 512 || stack.length >= 16) invalid();
            let spaced = whitespace();
            while (source[offset] !== '>' && source.slice(offset, offset + 2) !== '/>') {
                if (!spaced) invalid();
                const key = name();
                if (Object.prototype.hasOwnProperty.call(node.attributes, key)) invalid();
                whitespace();
                if (source[offset++] !== '=') invalid();
                whitespace();
                const quote = source[offset++];
                if (quote !== '"' && quote !== "'") invalid();
                const end = source.indexOf(quote, offset);
                if (end < 0) invalid();
                const raw = source.slice(offset, end);
                if (raw.indexOf('<') >= 0) invalid();
                node.attributes[key] = entities(raw.replace(/[\t\r\n]/g, ' '));
                offset = end + 1;
                spaced = whitespace();
            }
            if (stack.length) stack[stack.length - 1].children.push(node);
            else {
                if (root) invalid();
                root = node;
            }
            if (source.slice(offset, offset + 2) === '/>') offset += 2;
            else { ++offset; stack.push(node); }
        }
    }
    if (!root || stack.length) invalid();
    return root;
}
