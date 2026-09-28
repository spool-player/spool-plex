// SPDX-License-Identifier: MPL-2.0
import { parseXml } from '../logic/xml.mjs';
function check(value, message) { if (!value) throw new Error('xml contract: ' + message); }
function rejected(source) {
    let error = '';
    try { parseXml(source); } catch (failure) { error = failure.message; }
    check(error === 'invalid_xml', 'reject malformed or excessive XML');
}
export function run() {
    const root = parseXml('<?xml version="1.0" encoding="UTF-8"?><MediaContainer><!-- Home and Companion -->'
        + '<User id="7" title="A &amp; B &quot;quoted&quot; &gt;" pin="&#49;&#x32;" __proto__="safe"/>'
        + '<Player title=\'a > b\'><![CDATA[x < y]]>&#x1F600;</Player></MediaContainer>');
    check(root.children[0].attributes.title === 'A & B "quoted" >' && root.children[0].attributes.pin === '12',
        'quoted attributes and built-in/numeric entities decode without changing identity');
    check(root.children[0].attributes.__proto__ === 'safe' && root.children[1].text === 'x < y' + String.fromCodePoint(0x1f600),
        'attribute names cannot alter object prototypes; text and supplementary codepoints survive');
    ['<!DOCTYPE x><x/>', '<!DOCTYPE x [<!ENTITY a "secret">]><x>&a;</x>', '<x a="&file;"/>', '<x>&bogus;</x>',
        '<x a="&#0;"/>', '<x a="&#xD800;"/>', '<x>&#1114112;</x>', '<x a="unclosed/>', '<x a="<y"/>',
        '<x><y></x></y>', '<x/><y/>', '<x a="1" a="2"/>', '<x a="1"b="2"/>', '<x>', '<x/>tail',
        '<x><!-- bad--comment --></x>', '<x>]]></x>', '<x><?other x?></x>', '<x>&amp</x>', '<x>\u0001</x>']
        .forEach(rejected);
    parseXml('<x>' + '<n/>'.repeat(511) + '</x>');
    rejected('<x>' + '<n/>'.repeat(512) + '</x>');
    parseXml('<n>'.repeat(16) + '</n>'.repeat(16));
    rejected('<n>'.repeat(17) + '</n>'.repeat(17));
    parseXml('<x>' + 'a'.repeat(262137) + '</x>');
    rejected('<x>' + 'a'.repeat(262138) + '</x>');
    rejected('<x>' + '\u0800'.repeat(90000) + '</x>');
}
