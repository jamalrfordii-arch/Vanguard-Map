// tests/_stubs/xmlDom.mjs — a minimal, dependency-free XML DOM for Node tests.
//
// Browsers give rtzCodec.js a real DOMParser. Node does not, and Vanguard1 has
// no dependencies and no bundler, so rather than add one this provides exactly
// the DOM surface rtzCodec touches:
//
//     doc.documentElement, doc.getElementsByTagName(name)
//     el.nodeType, el.nodeName, el.localName, el.childNodes
//     el.getAttribute(name), el.textContent
//
// Same spirit as _stubs/three.mjs: stub the platform, not the module under test,
// so the production code path is the one being exercised.
//
// SCOPE — this is a test fixture, not an XML library. It handles the subset RTZ
// uses: the XML declaration, comments, CDATA, self-closing and paired elements,
// attributes in single or double quotes, the five predefined entities plus
// numeric character references, and namespace prefixes (split into localName).
// It does NOT do DTDs, entity declarations, or namespace resolution — none of
// which appear in RTZ. Malformed input produces a <parsererror> element, which
// is precisely how a browser DOMParser signals failure and what rtzCodec checks.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
        if (body[0] === '#') {
            const cp = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
    });
}

class Node {
    constructor(type) {
        this.nodeType = type;
        this.childNodes = [];
        this.parentNode = null;
    }
}

class TextNode extends Node {
    constructor(data) { super(TEXT_NODE); this.nodeValue = data; }
    get textContent() { return this.nodeValue; }
}

class Element extends Node {
    constructor(qName) {
        super(ELEMENT_NODE);
        this.nodeName = qName;
        const i = qName.indexOf(':');
        this.prefix = i === -1 ? null : qName.slice(0, i);
        this.localName = i === -1 ? qName : qName.slice(i + 1);
        this._attrs = new Map();
    }
    getAttribute(name) {
        if (this._attrs.has(name)) return this._attrs.get(name);
        // Browsers match getAttribute on the qualified name; RTZ producers are
        // inconsistent about prefixes, so fall back to a local-name match.
        for (const [k, v] of this._attrs) {
            const local = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
            if (local === name) return v;
        }
        return null;
    }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
    appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
    get textContent() {
        return this.childNodes.map(c => c.textContent ?? '').join('');
    }
    getElementsByTagName(name) {
        const out = [];
        const want = String(name);
        const walk = (el) => {
            for (const c of el.childNodes) {
                if (c.nodeType !== ELEMENT_NODE) continue;
                if (want === '*' || c.nodeName === want || c.localName === want) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
}

class XmlDocument {
    constructor() { this.documentElement = null; }
    getElementsByTagName(name) {
        if (!this.documentElement) return [];
        const self = [];
        if (name === '*' || this.documentElement.nodeName === name ||
            this.documentElement.localName === name) self.push(this.documentElement);
        return [...self, ...this.documentElement.getElementsByTagName(name)];
    }
}

function errorDoc(message) {
    const doc = new XmlDocument();
    const el = new Element('parsererror');
    el.appendChild(new TextNode(message));
    doc.documentElement = el;
    return doc;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(el, src) {
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(src)) !== null) {
        el._attrs.set(m[1], decodeEntities(m[3] !== undefined ? m[3] : m[4]));
    }
}

export class DOMParser {
    parseFromString(xml, _mimeType) {
        if (typeof xml !== 'string') return errorDoc('input is not a string');

        const doc = new XmlDocument();
        const stack = [];
        let root = null;
        let i = 0;
        const n = xml.length;

        while (i < n) {
            const lt = xml.indexOf('<', i);

            if (lt === -1) break;

            // Character data between elements.
            if (lt > i) {
                const text = xml.slice(i, lt);
                if (stack.length && text.trim() !== '') {
                    stack[stack.length - 1].appendChild(new TextNode(decodeEntities(text)));
                }
            }

            // <?xml ... ?>  processing instruction / declaration
            if (xml.startsWith('<?', lt)) {
                const end = xml.indexOf('?>', lt);
                if (end === -1) return errorDoc('unterminated processing instruction');
                i = end + 2;
                continue;
            }

            // <!-- comment -->
            if (xml.startsWith('<!--', lt)) {
                const end = xml.indexOf('-->', lt);
                if (end === -1) return errorDoc('unterminated comment');
                i = end + 3;
                continue;
            }

            // <![CDATA[ ... ]]>
            if (xml.startsWith('<![CDATA[', lt)) {
                const end = xml.indexOf(']]>', lt);
                if (end === -1) return errorDoc('unterminated CDATA section');
                if (stack.length) {
                    stack[stack.length - 1].appendChild(new TextNode(xml.slice(lt + 9, end)));
                }
                i = end + 3;
                continue;
            }

            // <!DOCTYPE ...>  — skipped, not supported
            if (xml.startsWith('<!', lt)) {
                const end = xml.indexOf('>', lt);
                if (end === -1) return errorDoc('unterminated declaration');
                i = end + 1;
                continue;
            }

            // </closing>
            if (xml.startsWith('</', lt)) {
                const end = xml.indexOf('>', lt);
                if (end === -1) return errorDoc('unterminated closing tag');
                const name = xml.slice(lt + 2, end).trim();
                const open = stack.pop();
                if (!open) return errorDoc(`unexpected closing tag </${name}>`);
                if (open.nodeName !== name) {
                    return errorDoc(`mismatched tag: expected </${open.nodeName}>, got </${name}>`);
                }
                i = end + 1;
                continue;
            }

            // <opening ...>  or  <selfclosing .../>
            // Find the '>' that ends the tag, skipping any inside quoted values.
            let j = lt + 1, quote = null, end = -1;
            while (j < n) {
                const ch = xml[j];
                if (quote) { if (ch === quote) quote = null; }
                else if (ch === '"' || ch === "'") quote = ch;
                else if (ch === '>') { end = j; break; }
                j++;
            }
            if (end === -1) return errorDoc('unterminated tag');

            let inner = xml.slice(lt + 1, end);
            const selfClosing = inner.endsWith('/');
            if (selfClosing) inner = inner.slice(0, -1);

            const sp = inner.search(/\s/);
            const qName = (sp === -1 ? inner : inner.slice(0, sp)).trim();
            if (!qName) return errorDoc('empty tag name');

            const el = new Element(qName);
            if (sp !== -1) parseAttributes(el, inner.slice(sp));

            if (stack.length) stack[stack.length - 1].appendChild(el);
            else if (root) return errorDoc('multiple root elements');
            else root = el;

            if (!selfClosing) stack.push(el);
            i = end + 1;
        }

        if (stack.length) return errorDoc(`unclosed tag <${stack[stack.length - 1].nodeName}>`);
        if (!root) return errorDoc('no root element');

        doc.documentElement = root;
        return doc;
    }
}

/** Install DOMParser as a global, for code that reaches for it directly. */
export function installDOMParser() {
    if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
    return globalThis.DOMParser;
}

export default DOMParser;
