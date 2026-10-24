'use strict';

/* ============================================================
   XLogo Online - XLogo interpreter
   Coordinate system and commands follow XLogoOnline
   (ETH Zürich): origin (0,0) at center, heading 0 is up.
   ============================================================ */

/* ---------- Errors and control signals ---------- */

class LogoError extends Error {
    constructor(message, line = null) {
        super(message);
        this.name = 'LogoError';
        this.line = line;
    }
}

class StopSignal {}                       // STOP inside procedure
class ReturnSignal {                      // OUTPUT inside procedure
    constructor(value) { this.value = value; }
}
class RunStopped {}                       // Stop button pressed

/* ---------- Tokenizer ---------- */

const WORD_CHAR = /[\p{L}\p{N}_.?!%&'#]/u;

function tokenize(source) {
    let i = 0;
    let line = 1;

    const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
    const isDelim = (c) => isSpace(c) || '[]()+-*/<>=;"'.includes(c);

    function skip() {
        for (;;) {
            if (i >= source.length) return;
            const c = source[i];
            if (c === '\n') { line++; i++; continue; }
            if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
            if (c === ';') {
                while (i < source.length && source[i] !== '\n') i++;
                continue;
            }
            return;
        }
    }

    function readList(startLine) {
        const items = [];
        i++; // skip '['
        for (;;) {
            skip();
            if (i >= source.length) {
                throw new LogoError('Unclosed bracket «[»', startLine);
            }
            if (source[i] === ']') {
                i++;
                return { type: 'list', items, line: startLine };
            }
            items.push(readToken());
        }
    }

    function readToken() {
        skip();
        if (i >= source.length) return null;

        const startLine = line;
        const c = source[i];

        if (c === '[') return readList(startLine);
        if (c === ']') throw new LogoError('Extra closing bracket «]»', startLine);

        if (c === '"') {
            i++;
            let s = '';
            while (i < source.length && !isDelim(source[i])) s += source[i++];
            return { type: 'word', value: s, quoted: true, line: startLine };
        }

        if (c === ':') {
            i++;
            let s = '';
            while (i < source.length && !isDelim(source[i])) s += source[i++];
            if (!s) throw new LogoError('Variable name expected after «:»', startLine);
            return { type: 'var', name: s.toLowerCase(), line: startLine };
        }

        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] || ''))) {
            let s = '';
            while (i < source.length && /[0-9.]/.test(source[i])) s += source[i++];
            const n = Number(s);
            if (Number.isNaN(n)) throw new LogoError(`Cannot parse number «${s}»`, startLine);
            return { type: 'number', value: n, line: startLine };
        }

        if ('+-*/<>='.includes(c)) {
            let op = c;
            const two = source.substr(i, 2);
            if (two === '<=' || two === '>=' || two === '<>') {
                op = two;
                i += 2;
            } else {
                i++;
            }
            return { type: 'op', value: op, line: startLine };
        }

        if (c === '(' || c === ')') {
            i++;
            return { type: 'op', value: c, line: startLine };
        }

        if (WORD_CHAR.test(c)) {
            let s = '';
            while (i < source.length && WORD_CHAR.test(source[i])) s += source[i++];
            return { type: 'word', value: s, line: startLine };
        }

        throw new LogoError(`Unknown character «${c}»`, startLine);
    }

    const tokens = [];
    for (;;) {
        skip();
        if (i >= source.length) break;
        const token = readToken();
        if (token) tokens.push(token);
    }
    return tokens;
}

/* ---------- Values ---------- */

class LogoList {
    constructor(items) { this.items = items; }
}

function tokenText(t) {
    switch (t.type) {
        case 'number': return String(t.value);
        case 'word': return t.quoted ? '"' + t.value : t.value;
        case 'var': return ':' + t.name;
        case 'list': return '[' + t.items.map(tokenText).join(' ') + ']';
        case 'op': return t.value;
        default: return '';
    }
}

function formatValue(v) {
    if (v instanceof LogoList) return '[' + v.items.map(tokenText).join(' ') + ']';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null || v === undefined) return '';
    return String(v);
}

function describeToken(t) {
    if (!t) return 'end of program';
    if (t.type === 'number') return `number ${t.value}`;
    if (t.type === 'list') return 'list';
    return `«${tokenText(t)}»`;
}

function toNumber(v, line) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
        return Number(v);
    }
    throw new LogoError(`Expected a number, got «${formatValue(v)}»`, line);
}

function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        return s !== '' && s !== 'false' && s !== '0';
    }
    return Boolean(v);
}

function normalizeAngle(a) {
    return ((a % 360) + 360) % 360;
}

/* ---------- World state ---------- */

const turtle = {
    x: 0,
    y: 0,
    heading: 0,
    penDown: true,
    penWidth: 2,
    penColor: '#1f9d55',
    eraser: false
};

let bgColor = '#ffffff';
let scene = [];                 // all strokes (for resize redraw)

const view = { w: 0, h: 0, dpr: 1 };

const globalVars = new Map();
const frames = [globalVars];
const procedures = new Map();
const repcountStack = [];

let abortFlag = false;
let running = false;
let tickCounter = 0;

function getVar(name, line) {
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].has(name)) return frames[i].get(name);
    }
    throw new LogoError(`Variable «:${name}» is not defined`, line);
}

function setVar(name, value) {
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].has(name)) {
            frames[i].set(name, value);
            return;
        }
    }
    globalVars.set(name, value);
}

/* ---------- Built-in functions ---------- */

const FUNCTIONS = {
    sum: 2, difference: 2, product: 2, quotient: 2, power: 2, modulo: 2,
    sqrt: 1, abs: 1, int: 1, round: 1, random: 1,
    sin: 1, cos: 1, tan: 1, arctan: 1,
    min: 2, max: 2,
    count: 1,
    not: 1,
    xcor: 0, ycor: 0, heading: 0, repcount: 0,
    pi: 0
};

function callFunction(name, args, line) {
    const num = (v) => toNumber(v, line);
    const deg = Math.PI / 180;

    switch (name) {
        case 'sum': return num(args[0]) + num(args[1]);
        case 'difference': return num(args[0]) - num(args[1]);
        case 'product': return num(args[0]) * num(args[1]);
        case 'quotient': {
            const d = num(args[1]);
            if (d === 0) throw new LogoError('Division by zero', line);
            return num(args[0]) / d;
        }
        case 'power': return Math.pow(num(args[0]), num(args[1]));
        case 'modulo': {
            const d = num(args[1]);
            if (d === 0) throw new LogoError('Division by zero', line);
            return num(args[0]) % d;
        }
        case 'sqrt': {
            const v = num(args[0]);
            if (v < 0) throw new LogoError('Square root of negative number', line);
            return Math.sqrt(v);
        }
        case 'abs': return Math.abs(num(args[0]));
        case 'int': return Math.trunc(num(args[0]));
        case 'round': return Math.round(num(args[0]));
        case 'random': {
            const n = Math.floor(num(args[0]));
            if (n <= 0) throw new LogoError('RANDOM expects a positive number', line);
            return Math.floor(Math.random() * n);
        }
        case 'sin': return Math.sin(num(args[0]) * deg);
        case 'cos': return Math.cos(num(args[0]) * deg);
        case 'tan': return Math.tan(num(args[0]) * deg);
        case 'arctan': return Math.atan(num(args[0])) / deg;
        case 'min': return Math.min(num(args[0]), num(args[1]));
        case 'max': return Math.max(num(args[0]), num(args[1]));
        case 'count':
            if (args[0] instanceof LogoList) return args[0].items.length;
            return String(formatValue(args[0])).length;
        case 'not': return !truthy(args[0]);
        case 'xcor': return turtle.x;
        case 'ycor': return turtle.y;
        case 'heading': return turtle.heading;
        case 'repcount': return repcountStack.length ? repcountStack[repcountStack.length - 1] : 0;
        case 'pi': return Math.PI;
        default: throw new LogoError(`Unknown function «${name}»`, line);
    }
}

/* ---------- Expression parser ---------- */

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }

    peek(offset = 0) { return this.tokens[this.pos + offset]; }
    eof() { return this.pos >= this.tokens.length; }
    next() { return this.tokens[this.pos++]; }

    isWord(value) {
        const t = this.peek();
        return Boolean(t && t.type === 'word' && !t.quoted && t.value.toLowerCase() === value);
    }

    expectOp(value) {
        const t = this.next();
        if (!t || t.type !== 'op' || t.value !== value) {
            throw new LogoError(`Expected «${value}»`, t ? t.line : null);
        }
    }

    parseExpression() {
        return this.parseOr();
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.isWord('or')) {
            this.next();
            const right = this.parseAnd();
            left = truthy(left) || truthy(right);
        }
        return left;
    }

    parseAnd() {
        let left = this.parseComparison();
        while (this.isWord('and')) {
            this.next();
            const right = this.parseComparison();
            left = truthy(left) && truthy(right);
        }
        return left;
    }

    parseComparison() {
        let left = this.parseAdditive();
        for (;;) {
            const t = this.peek();
            if (!t || t.type !== 'op' || !['=', '<', '>', '<=', '>=', '<>'].includes(t.value)) break;
            this.next();
            const right = this.parseAdditive();
            left = compareValues(left, right, t.value, t.line);
        }
        return left;
    }

    parseAdditive() {
        let left = this.parseMultiplicative();
        for (;;) {
            const t = this.peek();
            if (!t || t.type !== 'op' || (t.value !== '+' && t.value !== '-')) break;
            this.next();
            const right = this.parseMultiplicative();
            left = t.value === '+'
                ? toNumber(left, t.line) + toNumber(right, t.line)
                : toNumber(left, t.line) - toNumber(right, t.line);
        }
        return left;
    }

    parseMultiplicative() {
        let left = this.parseUnary();
        for (;;) {
            const t = this.peek();
            if (!t || t.type !== 'op' || (t.value !== '*' && t.value !== '/')) break;
            this.next();
            const right = this.parseUnary();
            if (t.value === '*') {
                left = toNumber(left, t.line) * toNumber(right, t.line);
            } else {
                const d = toNumber(right, t.line);
                if (d === 0) throw new LogoError('Division by zero', t.line);
                left = toNumber(left, t.line) / d;
            }
        }
        return left;
    }

    parseUnary() {
        const t = this.peek();
        if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
            this.next();
            const v = toNumber(this.parseUnary(), t.line);
            return t.value === '-' ? -v : v;
        }
        return this.parsePrimary();
    }

    parsePrimary() {
        const t = this.next();
        if (!t) throw new LogoError('Unexpected end of program');

        if (t.type === 'number') return t.value;
        if (t.type === 'word' && t.quoted) return t.value;
        if (t.type === 'var') return getVar(t.name, t.line);
        if (t.type === 'list') return new LogoList(t.items);

        if (t.type === 'op' && t.value === '(') {
            const v = this.parseExpression();
            this.expectOp(')');
            return v;
        }

        if (t.type === 'word') {
            const name = t.value.toLowerCase();

            if (name === 'true') return true;
            if (name === 'false') return false;

            if (Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) {
                const argc = FUNCTIONS[name];
                const args = [];
                for (let k = 0; k < argc; k++) {
                    if (this.eof()) {
                        throw new LogoError(`Function «${t.value}» expects ${argc} argument(s)`, t.line);
                    }
                    args.push(this.parseExpression());
                }
                return callFunction(name, args, t.line);
            }

            throw new LogoError(`Unknown function «${t.value}»`, t.line);
        }

        throw new LogoError(`Unexpected element ${describeToken(t)}`, t.line);
    }
}

function compareValues(a, b, op, line) {
    let cmp;

    if (typeof a === 'number' && typeof b === 'number') {
        cmp = a < b ? -1 : a > b ? 1 : 0;
    } else {
        const sa = formatValue(a).toLowerCase();
        const sb = formatValue(b).toLowerCase();
        cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
    }

    switch (op) {
        case '=': return cmp === 0;
        case '<>': return cmp !== 0;
        case '<': return cmp < 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '>=': return cmp >= 0;
        default: throw new LogoError(`Unknown operator «${op}»`, line);
    }
}

/* ---------- Colors ---------- */

const PALETTE = [
    '#000000', '#e53935', '#2e9e4f', '#f2c200', '#1e6fd9', '#d81b9a', '#00acc1', '#ffffff',
    '#7f8c8d', '#c0c0c0', '#8d5524', '#ff8c00', '#7b3fa0', '#ff6fa5', '#76d275', '#008080'
];

const COLOR_NAMES = {
    black: 0, schwarz: 0, black: 0, black: 0,
    red: 1, rot: 1, red: 1,
    green: 2, grün: 2, gruen: 2, green: 2, green: 2,
    yellow: 3, gelb: 3, yellow: 3, yellow: 3,
    blue: 4, blau: 4, blue: 4, blue: 4,
    magenta: 5, pink: 13, rosa: 13, pink: 13,
    cyan: 6, turquoise: 6,
    white: 7, weiss: 7, white: 7, white: 7,
    gray: 8, grey: 8, grau: 8, gray: 8,
    silver: 9, silver: 9,
    brown: 10, braun: 10, brown: 10,
    orange: 11, orange: 11,
    purple: 12, violett: 12, lila: 12, purple: 12,
    lime: 14,
    teal: 15,
    navy: '#001f5b', gold: '#d4af37', olive: '#808000',
    maroon: '#800000', turquoise: 6
};

function colorFromValue(value, line) {
    if (typeof value === 'number') {
        const idx = Math.trunc(value);
        if (idx < 0 || idx >= PALETTE.length) {
            throw new LogoError(`Color index must be between 0 and ${PALETTE.length - 1}`, line);
        }
        return PALETTE[idx];
    }

    const raw = String(value).trim();
    const s = raw.toLowerCase();

    if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) return raw;
    if (/^[0-9]+$/.test(s)) return colorFromValue(Number(s), line);

    if (Object.prototype.hasOwnProperty.call(COLOR_NAMES, s)) {
        const c = COLOR_NAMES[s];
        return typeof c === 'number' ? PALETTE[c] : c;
    }

    throw new LogoError(`Unknown color «${raw}»`, line);
}

function colorFromList(list, line) {
    const nums = list.items.map((t) => {
        if (t.type === 'number') return t.value;
        if (t.type === 'word' && !Number.isNaN(Number(t.value))) return Number(t.value);
        throw new LogoError('Color list must contain numbers from 0 to 255', t.line);
    });
    if (nums.length !== 3) {
        throw new LogoError('Color list requires three numbers: [R G B]', line);
    }
    const [r, g, b] = nums.map((n) => Math.max(0, Math.min(255, Math.round(n))));
    return `rgb(${r}, ${g}, ${b})`;
}

/* ---------- DOM references ---------- */

const appEl = document.getElementById('app');
const stageEl = document.getElementById('stage');
const viewEl = document.getElementById('view');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const turtleEl = document.getElementById('turtle');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const posXEl = document.getElementById('posX');
const posYEl = document.getElementById('posY');
const headingEl = document.getElementById('headingOut');
const penChipEl = document.getElementById('penChip');
const codeEl = document.getElementById('code');
const gutterInner = document.getElementById('gutterInner');
const runBtn = document.getElementById('runBtn');
const stopBtn = document.getElementById('stopBtn');
const speedEl = document.getElementById('speed');
const examplesEl = document.getElementById('examples');
const fileInput = document.getElementById('fileInput');
const helpDialog = document.getElementById('helpDialog');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomResetBtn = document.getElementById('zoomResetBtn');
const panResetBtn = document.getElementById('panResetBtn');

/* ---------- View / Pan & Zoom ---------- */

const MIN_VIEW_SCALE = 0.25;
const MAX_VIEW_SCALE = 4;

let viewScale = 1;
let viewPanX = 0;
let viewPanY = 0;

/* Pointer-based panning: works with mouse, trackpad, finger and stylus. */
let isPanning = false;
let panPointerId = null;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

const activePointers = new Map();   // pointerId -> { x, y }
let pinch = null;                   // { startDist, anchor, panX, panY, scale }

function applyViewTransform() {
    if (!viewEl) return;
    viewEl.style.transform = `translate(calc(-50% + ${viewPanX}px), calc(-50% + ${viewPanY}px)) scale(${viewScale})`;
}

function updateZoomLabel() {
    if (!zoomResetBtn) return;
    zoomResetBtn.textContent = `${Math.round(viewScale * 100)}%`;
}

function applyZoom(newScale, anchorX, anchorY) {
    if (!stageEl) return;

    const clamped = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, newScale));
    if (Math.abs(clamped - viewScale) < 0.0001) return;

    viewPanX = anchorX - (anchorX - viewPanX) * (clamped / viewScale);
    viewPanY = anchorY - (anchorY - viewPanY) * (clamped / viewScale);
    viewScale = clamped;

    applyViewTransform();
    updateZoomLabel();
}

function zoomBy(delta, clientX, clientY) {
    if (!stageEl) return;

    const rect = stageEl.getBoundingClientRect();
    const cx = clientX !== undefined ? (clientX - rect.left) : rect.width / 2;
    const cy = clientY !== undefined ? (clientY - rect.top) : rect.height / 2;

    applyZoom(viewScale + delta, cx, cy);
}

function resetView() {
    viewScale = 1;
    viewPanX = 0;
    viewPanY = 0;
    applyViewTransform();
    updateZoomLabel();
}

function stagePoint(clientX, clientY) {
    const rect = stageEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
}

function pointerDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function startPan(pointerId) {
    const p = activePointers.get(pointerId);
    if (!p) return;

    isPanning = true;
    panPointerId = pointerId;
    panStartX = p.x;
    panStartY = p.y;
    panOriginX = viewPanX;
    panOriginY = viewPanY;
    stageEl.classList.add('is-panning');
}

function stopPan() {
    isPanning = false;
    panPointerId = null;
    stageEl.classList.remove('is-panning');
}

function startPinch() {
    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return;

    const mid = pointerMidpoint(pts[0], pts[1]);
    const anchor = stagePoint(mid.x, mid.y);

    pinch = {
        startDist: Math.max(1, pointerDistance(pts[0], pts[1])),
        anchor,
        panX: viewPanX,
        panY: viewPanY,
        scale: viewScale
    };

    isPanning = false;
    panPointerId = null;
}

function updatePinch() {
    if (!pinch) return;

    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return;

    const mid = pointerMidpoint(pts[0], pts[1]);
    const midStage = stagePoint(mid.x, mid.y);
    const dist = Math.max(1, pointerDistance(pts[0], pts[1]));

    const ratio = dist / pinch.startDist;
    const newScale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, pinch.scale * ratio));
    const scaleRatio = newScale / pinch.scale;

    viewPanX = midStage.x - (pinch.anchor.x - pinch.panX) * scaleRatio;
    viewPanY = midStage.y - (pinch.anchor.y - pinch.panY) * scaleRatio;
    viewScale = newScale;

    applyViewTransform();
    updateZoomLabel();
}

function isTrackpadPan(e) {
    if (e.deltaMode !== 0) return false;                  // line/page deltas — classic mouse wheel
    if (Math.abs(e.deltaX) > 0.5) return true;            // horizontal component — trackpad swipe
    const dy = Math.abs(e.deltaY);
    if (dy < 50) return true;                             // fine-grained deltas — trackpad
    if (dy % 100 === 0 || dy % 120 === 0) return false;   // typical mouse wheel notches
    return true;
}

function initPanZoom() {
    if (!stageEl || !viewEl) return;

    applyViewTransform();
    updateZoomLabel();

    if (zoomInBtn) zoomInBtn.addEventListener('click', (e) => zoomBy(0.15, e.clientX, e.clientY));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', (e) => zoomBy(-0.15, e.clientX, e.clientY));
    if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetView);
    if (panResetBtn) panResetBtn.addEventListener('click', resetView);

    /* Wheel / trackpad:
       - two-finger trackpad swipe pans the map
       - pinch on trackpad (ctrl+wheel) zooms
       - classic mouse wheel zooms
       - shift + wheel pans horizontally */
    stageEl.addEventListener('wheel', (e) => {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            const rect = stageEl.getBoundingClientRect();
            const factor = Math.exp(-e.deltaY * 0.01);
            applyZoom(viewScale * factor, e.clientX - rect.left, e.clientY - rect.top);
            return;
        }

        if (e.shiftKey) {
            viewPanX -= (e.deltaX || e.deltaY);
            applyViewTransform();
            return;
        }

        if (isTrackpadPan(e)) {
            viewPanX -= e.deltaX;
            viewPanY -= e.deltaY;
            applyViewTransform();
            return;
        }

        const delta = e.deltaY > 0 ? -0.12 : 0.12;
        zoomBy(delta, e.clientX, e.clientY);
    }, { passive: false });

    /* Pointer events unify mouse, trackpad, touch and stylus. */
    stageEl.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.view-controls')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        try {
            stageEl.setPointerCapture(e.pointerId);
        } catch (_) {}

        if (activePointers.size === 1) {
            startPan(e.pointerId);
        } else if (activePointers.size === 2) {
            startPinch();
        }

        e.preventDefault();
    });

    stageEl.addEventListener('pointermove', (e) => {
        const p = activePointers.get(e.pointerId);
        if (!p) return;

        p.x = e.clientX;
        p.y = e.clientY;

        if (activePointers.size >= 2) {
            updatePinch();
        } else if (isPanning && panPointerId === e.pointerId) {
            viewPanX = panOriginX + (e.clientX - panStartX);
            viewPanY = panOriginY + (e.clientY - panStartY);
            applyViewTransform();
        }

        e.preventDefault();
    }, { passive: false });

    function releasePointer(e) {
        if (!activePointers.has(e.pointerId)) return;

        activePointers.delete(e.pointerId);

        try {
            stageEl.releasePointerCapture(e.pointerId);
        } catch (_) {}

        if (activePointers.size >= 2) {
            startPinch();
        } else if (activePointers.size === 1) {
            pinch = null;
            startPan(activePointers.keys().next().value);
        } else {
            pinch = null;
            stopPan();
        }
    }

    stageEl.addEventListener('pointerup', releasePointer);
    stageEl.addEventListener('pointercancel', releasePointer);
    stageEl.addEventListener('lostpointercapture', releasePointer);

    /* Stop Safari from zooming the whole page on a two-finger pinch over the map. */
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
        stageEl.addEventListener(name, (e) => e.preventDefault(), { passive: false });
    });

    stageEl.addEventListener('dblclick', (e) => {
        if (e.target && e.target.closest && e.target.closest('.view-controls')) return;
        resetView();
    });
}

/* ---------- Drawing ---------- */



const DRAW_SIZE = 4096;

function applyCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1);

    view.w = DRAW_SIZE;
    view.h = DRAW_SIZE;
    view.dpr = dpr;

    try {
        canvas.width = Math.round(DRAW_SIZE * dpr);
        canvas.height = Math.round(DRAW_SIZE * dpr);
    } catch (e) {
        // try smaller
        const smaller = 2048;
        view.w = smaller;
        view.h = smaller;
        canvas.width = Math.round(smaller);
        canvas.height = Math.round(smaller);
        canvas.style.width = smaller + 'px';
        canvas.style.height = smaller + 'px';
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        } catch (_) {}
        try { renderScene(); } catch (_) { scene = []; }
        updateTurtle();
        return;
    }

    canvas.style.width = DRAW_SIZE + 'px';
    canvas.style.height = DRAW_SIZE + 'px';

    try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch (e) {
        return;
    }

    try {
        renderScene();
    } catch (e) {
        scene = [];
    }

    updateTurtle();
}

function renderScene() {
    if (!ctx || !view.w || !view.h) return;
    try {
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        ctx.clearRect(0, 0, view.w, view.h);
        for (const op of scene) drawStroke(op);
    } catch (e) {
        // ignore canvas errors
    }
}

function drawStroke(op) {
    if (!ctx || !view.w) return;
    const cx = view.w / 2;
    const cy = view.h / 2;

    try {
        ctx.save();
        ctx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + op.x1, cy - op.y1);
        ctx.lineTo(cx + op.x2, cy - op.y2);
        ctx.stroke();
        ctx.restore();
    } catch (e) {
        // ignore
    }
}

function addStroke(x1, y1, x2, y2) {
    if (x1 === x2 && y1 === y2) return;
    if (Math.abs(x1) > 50000 || Math.abs(x2) > 50000 || Math.abs(y1) > 50000 || Math.abs(y2) > 50000) {
        turtle.x = x2;
        turtle.y = y2;
        return;
    }
    const op = {
        x1, y1, x2, y2,
        color: turtle.penColor,
        width: turtle.penWidth,
        erase: turtle.eraser
    };
    scene.push(op);
    try {
        drawStroke(op);
    } catch (e) {
        // ignore
    }
}

function clearDrawing() {
    scene = [];
    renderScene();
}

function formatCoord(v) {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function updateTurtle() {
    if (!view.w || !view.h) return;

    turtleEl.style.left = `${view.w / 2 + turtle.x}px`;
    turtleEl.style.top = `${view.h / 2 - turtle.y}px`;
    turtleEl.style.transform = `translate(-50%, -50%) rotate(${turtle.heading}deg)`;

    posXEl.textContent = formatCoord(turtle.x);
    posYEl.textContent = formatCoord(turtle.y);
    headingEl.textContent = `${formatCoord(normalizeAngle(turtle.heading))}°`;
}

function updatePenChip() {
    penChipEl.style.background = turtle.penColor;
    penChipEl.classList.toggle('eraser', turtle.eraser);
    penChipEl.title = turtle.eraser ? 'Eraser' : `Pen color: ${turtle.penColor}`;
}

function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = kind;
}

function printOutput(text, kind = '') {
    const line = document.createElement('div');
    line.className = 'line' + (kind ? ' ' + kind : '');
    line.textContent = text;
    outputEl.appendChild(line);
    while (outputEl.children.length > 400) outputEl.removeChild(outputEl.firstChild);
    outputEl.parentElement.scrollTop = outputEl.parentElement.scrollHeight;
}

function showError(message, line = null) {
    const prefix = line ? `Line ${line}: ` : '';
    setStatus(prefix + message, 'error');
    printOutput(`Error${line ? ` (line ${line})` : ''}: ${message}`, 'error');

    errorLine = line;
    renderGutter();

    if (line) {
        const target = (line - 1) * 22;
        codeEl.scrollTop = Math.max(0, target - codeEl.clientHeight / 2);
        syncGutter();
    }
}

/* ---------- Turtle movement ---------- */

function forward(dist) {
    const rad = turtle.heading * Math.PI / 180;
    const nx = turtle.x + dist * Math.sin(rad);
    const ny = turtle.y + dist * Math.cos(rad);

    if (turtle.penDown) addStroke(turtle.x, turtle.y, nx, ny);
    turtle.x = nx;
    turtle.y = ny;
}

function moveTo(nx, ny) {
    if (turtle.penDown) addStroke(turtle.x, turtle.y, nx, ny);
    turtle.x = nx;
    turtle.y = ny;
}

/* ---------- Animation ---------- */

function currentDelay() {
    const value = Number(speedEl.value);       // 0 = slow, 100 = instant
    return Math.round((100 - value) * 1.6);
}

async function tick() {
    updateTurtle();

    if (abortFlag) throw new RunStopped();

    const delay = currentDelay();
    if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (abortFlag) throw new RunStopped();
    } else if ((++tickCounter % 250) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortFlag) throw new RunStopped();
    }
}

/* ---------- Command aliases ---------- */

const ALIASES = new Map();
const addAliases = (canon, ...names) => names.forEach((n) => ALIASES.set(n, canon));

addAliases('fd', 'fd', 'forward', 'vw', 'vorwärts');
addAliases('bk', 'bk', 'back', 'rw', 'rückwärts');
addAliases('rt', 'rt', 'right', 're', 'rechts');
addAliases('lt', 'lt', 'left', 'li', 'links');
addAliases('cs', 'cs', 'clearscreen', 'lb', 'löschebildschirm');
addAliases('home', 'home');
addAliases('wash', 'wash');
addAliases('pu', 'pu', 'penup');
addAliases('pd', 'pd', 'pendown');
addAliases('pe', 'pe', 'eraser');
addAliases('ppt', 'ppt');
addAliases('setpw', 'setpw', 'setpenwidth');
addAliases('setpc', 'setpc', 'setpencolor');
addAliases('setsc', 'setsc', 'setscreencolor');
addAliases('setx', 'setx');
addAliases('sety', 'sety');
addAliases('setxy', 'setxy');
addAliases('setheading', 'setheading', 'seth');
addAliases('repeat', 'repeat');
addAliases('if', 'if');
addAliases('ifelse', 'ifelse');
addAliases('make', 'make');
addAliases('print', 'print', 'pr', 'show');
addAliases('stop', 'stop');
addAliases('output', 'output', 'op');
addAliases('to', 'to');
addAliases('end', 'end');

/* ---------- Command arguments ---------- */

function nextArg(p, line, command) {
    if (p.eof()) {
        throw new LogoError(`Command «${command}» expects an argument`, line);
    }
    return p.parseExpression();
}

function nextList(p, line, command) {
    const value = nextArg(p, line, command);
    if (!(value instanceof LogoList)) {
        throw new LogoError(`Command «${command}» expects a list in brackets`, line);
    }
    return value;
}

function parseColorArg(p, line) {
    const t = p.peek();
    if (!t) throw new LogoError('Color expected', line);

    if (t.type === 'list') {
        p.next();
        return colorFromList(t, t.line);
    }
    if (t.type === 'number') {
        p.next();
        return colorFromValue(t.value, t.line);
    }
    if (t.type === 'word') {
        p.next();
        return colorFromValue(t.value, t.line);
    }

    return colorFromValue(p.parseExpression(), line);
}

/* ---------- Program execution ---------- */

async function execTokens(tokens, depth = 0) {
    const p = new Parser(tokens);
    while (!p.eof()) {
        if (abortFlag) throw new RunStopped();
        await execStatement(p, depth);
    }
}

async function execStatement(p, depth) {
    if (depth > 1500) throw new LogoError('Too deep recursion in procedures');

    const token = p.next();
    if (!token) return;

    const line = token.line;

    if (token.type !== 'word') {
        throw new LogoError(`Expected a command, got ${describeToken(token)}`, line);
    }

    const name = token.value.toLowerCase();
    const canon = ALIASES.get(name);

    switch (canon) {
        case 'fd': {
            const dist = toNumber(nextArg(p, line, 'FD'), line);
            forward(dist);
            await tick();
            return;
        }
        case 'bk': {
            const dist = toNumber(nextArg(p, line, 'BK'), line);
            forward(-dist);
            await tick();
            return;
        }
        case 'rt': {
            turtle.heading = normalizeAngle(turtle.heading + toNumber(nextArg(p, line, 'RT'), line));
            await tick();
            return;
        }
        case 'lt': {
            turtle.heading = normalizeAngle(turtle.heading - toNumber(nextArg(p, line, 'LT'), line));
            await tick();
            return;
        }
        case 'cs': {
            clearDrawing();
            turtle.x = 0;
            turtle.y = 0;
            turtle.heading = 0;
            await tick();
            return;
        }
        case 'home': {
            turtle.x = 0;
            turtle.y = 0;
            turtle.heading = 0;
            await tick();
            return;
        }
        case 'wash': {
            clearDrawing();
            await tick();
            return;
        }
        case 'pu': {
            turtle.penDown = false;
            await tick();
            return;
        }
        case 'pd': {
            turtle.penDown = true;
            await tick();
            return;
        }
        case 'pe': {
            turtle.eraser = true;
            turtle.penDown = true;
            updatePenChip();
            await tick();
            return;
        }
        case 'ppt': {
            turtle.eraser = false;
            updatePenChip();
            await tick();
            return;
        }
        case 'setpw': {
            const w = toNumber(nextArg(p, line, 'SETPW'), line);
            turtle.penWidth = Math.max(1, Math.min(50, w));
            await tick();
            return;
        }
        case 'setpc': {
            turtle.penColor = parseColorArg(p, line);
            turtle.eraser = false;
            updatePenChip();
            return;
        }
        case 'setsc': {
            bgColor = parseColorArg(p, line);
            stageEl.style.background = bgColor;
            return;
        }
        case 'setx': {
            moveTo(toNumber(nextArg(p, line, 'SETX'), line), turtle.y);
            await tick();
            return;
        }
        case 'sety': {
            moveTo(turtle.x, toNumber(nextArg(p, line, 'SETY'), line));
            await tick();
            return;
        }
        case 'setxy': {
            const x = toNumber(nextArg(p, line, 'SETXY'), line);
            const y = toNumber(nextArg(p, line, 'SETXY'), line);
            moveTo(x, y);
            await tick();
            return;
        }
        case 'setheading': {
            turtle.heading = normalizeAngle(toNumber(nextArg(p, line, 'SETHEADING'), line));
            await tick();
            return;
        }
        case 'repeat': {
            const count = Math.max(0, Math.floor(toNumber(nextArg(p, line, 'REPEAT'), line)));
            const body = nextList(p, line, 'REPEAT');
            for (let k = 1; k <= count; k++) {
                if (abortFlag) throw new RunStopped();
                repcountStack.push(k);
                try {
                    await execTokens(body.items, depth + 1);
                } finally {
                    repcountStack.pop();
                }
            }
            return;
        }
        case 'if': {
            const condition = nextArg(p, line, 'IF');
            const body = nextList(p, line, 'IF');
            if (truthy(condition)) await execTokens(body.items, depth + 1);
            return;
        }
        case 'ifelse': {
            const condition = nextArg(p, line, 'IFELSE');
            const yes = nextList(p, line, 'IFELSE');
            const no = nextList(p, line, 'IFELSE');
            await execTokens((truthy(condition) ? yes : no).items, depth + 1);
            return;
        }
        case 'make': {
            const rawName = nextArg(p, line, 'MAKE');
            const value = nextArg(p, line, 'MAKE');
            const varName = String(rawName).replace(/^"/, '').toLowerCase();
            if (!varName || /\s/.test(varName)) {
                throw new LogoError('MAKE expects a variable name: MAKE "x 10', line);
            }
            setVar(varName, value);
            return;
        }
        case 'print': {
            printOutput(formatValue(nextArg(p, line, 'PRINT')));
            return;
        }
        case 'stop': {
            throw new StopSignal();
        }
        case 'output': {
            throw new ReturnSignal(nextArg(p, line, 'OUTPUT'));
        }
        case 'to': {
            const nameToken = p.next();
            if (!nameToken || nameToken.type !== 'word' || nameToken.quoted) {
                throw new LogoError('TO expects a procedure name', line);
            }
            const procName = nameToken.value.toLowerCase();
            const params = [];
            while (p.peek() && p.peek().type === 'var') params.push(p.next().name);

            const bodyTokens = [];
            let closed = false;
            while (!p.eof()) {
                const t = p.next();
                if (t.type === 'word' && !t.quoted && t.value.toLowerCase() === 'end') {
                    closed = true;
                    break;
                }
                bodyTokens.push(t);
            }
            if (!closed) throw new LogoError(`Procedure «${procName}» is not closed with END`, line);

            procedures.set(procName, { params, body: bodyTokens });
            return;
        }
        case 'end': {
            throw new LogoError('END without TO', line);
        }
        default: {
            break;
        }
    }

    const proc = procedures.get(name);
    if (proc) {
        const args = [];
        for (let k = 0; k < proc.params.length; k++) {
            if (p.eof()) {
                throw new LogoError(`Procedure «${name}» expects ${proc.params.length} argument(s)`, line);
            }
            args.push(p.parseExpression());
        }

        const frame = new Map();
        proc.params.forEach((param, idx) => frame.set(param, args[idx]));

        frames.push(frame);
        try {
            await execTokens(proc.body, depth + 1);
        } catch (err) {
            if (!(err instanceof StopSignal) && !(err instanceof ReturnSignal)) throw err;
        } finally {
            frames.pop();
        }
        return;
    }

    throw new LogoError(`Unknown command «${token.value}»`, line);
}

/* ---------- Run ---------- */

async function runProgram() {
    if (running) return;

    running = true;
    abortFlag = false;
    tickCounter = 0;
    errorLine = null;
    frames.length = 1;
    repcountStack.length = 0;

    renderGutter();
    clearOutput();
    updateButtons();
    setStatus('Running…', 'running');

    try {
        const tokens = tokenize(codeEl.value);
        await execTokens(tokens, 0);
        setStatus('Ready', 'done');
    } catch (err) {
        if (err instanceof RunStopped) {
            setStatus('Stopped');
        } else if (err instanceof StopSignal || err instanceof ReturnSignal) {
            setStatus('Ready', 'done');
        } else if (err instanceof LogoError) {
            showError(err.message, err.line);
        } else {
            console.error(err);
            showError(`Internal error: ${err.message || err}`);
        }
    } finally {
        running = false;
        abortFlag = false;
        frames.length = 1;
        repcountStack.length = 0;
        updateButtons();
        updateTurtle();
    }
}

/* ---------- Editor ---------- */

let errorLine = null;

function renderGutter() {
    const lineCount = codeEl.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
        html += `<div${i === errorLine ? ' class="error"' : ''}>${i}</div>`;
    }
    gutterInner.innerHTML = html;
    syncGutter();
}

function syncGutter() {
    gutterInner.style.transform = `translateY(${-codeEl.scrollTop}px)`;
}

function clearOutput() {
    outputEl.innerHTML = '';
}

function updateButtons() {
    runBtn.disabled = running;
    stopBtn.disabled = !running;
}

/* ---------- Examples ---------- */

const DEFAULT_CODE = `; Welcome to XLogo Online!
; Press Run or Ctrl/⌘ + Enter to execute.

cs
setpc blue
repeat 4 [
  fd 140
  rt 90
]`;

const EXAMPLES = {
    square: `; Square
cs
setpc blue
repeat 4 [
  fd 140
  rt 90
]`,

    triangle: `; Triangle
cs
setpc green
repeat 3 [
  fd 150
  rt 120
]`,

    star: `; Star
cs
setpc orange
repeat 5 [
  fd 160
  rt 144
]`,

    spiral: `; Spiral using REPCOUNT
cs
setpc purple
repeat 45 [
  fd repcount * 4
  rt 90
]`,

    snowflake: `; Snowflake
cs
setpc cyan
repeat 6 [
  repeat 6 [
    fd 26
    rt 60
  ]
  rt 60
]`,

    flower: `; Flower
cs
setpc pink
repeat 12 [
  repeat 3 [
    fd 70
    rt 120
  ]
  rt 30
]`,

    procedure: `; Procedure with a parameter
to square :size
  repeat 4 [
    fd :size
    rt 90
  ]
end

cs
setpc blue
square 120

pu
fd 30
rt 90
fd 30
pd
setpc red
square 60`
};

/* ---------- Files ---------- */

function downloadUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function saveProgram() {
    const blob = new Blob([codeEl.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    downloadUrl(url, 'xlogo-program.logo');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Program saved');
}

function savePicture() {
    if (!canvas.width || !canvas.height) return;

    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const tctx = tmp.getContext('2d');

    tctx.fillStyle = bgColor;
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.drawImage(canvas, 0, 0);

    downloadUrl(tmp.toDataURL('image/png'), 'xlogo.png');
    setStatus('Image saved');
}

/* ---------- Initialization ---------- */

function init() {
    codeEl.value = DEFAULT_CODE;
    renderGutter();
    updatePenChip();
    updateTurtle();
    updateButtons();

    stageEl.style.background = bgColor;
    outputEl.innerHTML = '<div class="line muted">PRINT output and errors will appear here.</div>';
    setStatus('Ready');

    initPanZoom();

    requestAnimationFrame(applyCanvasSize);

    if ('ResizeObserver' in window) {
        const observer = new ResizeObserver(() => applyCanvasSize());
        observer.observe(stageEl);
    }
    window.addEventListener('resize', applyCanvasSize);

    /* Run and stop */
    runBtn.addEventListener('click', () => { runProgram(); });
    stopBtn.addEventListener('click', () => { abortFlag = true; });

    codeEl.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
            event.preventDefault();
            const start = codeEl.selectionStart;
            const end = codeEl.selectionEnd;
            codeEl.value = codeEl.value.slice(0, start) + '  ' + codeEl.value.slice(end);
            codeEl.selectionStart = codeEl.selectionEnd = start + 2;
            renderGutter();
            return;
        }

        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            runProgram();
        }
    });

    codeEl.addEventListener('input', () => {
        if (errorLine !== null) {
            errorLine = null;
            setStatus('Ready');
        }
        renderGutter();
    });

    codeEl.addEventListener('scroll', syncGutter);

    /* Canvas */
    document.getElementById('clearBtn').addEventListener('click', () => {
        if (running) abortFlag = true;
        clearDrawing();

        turtle.x = 0;
        turtle.y = 0;
        turtle.heading = 0;
        updateTurtle();
        setStatus('Cleared');
    });

    document.getElementById('homeBtn').addEventListener('click', () => {
        turtle.x = 0;
        turtle.y = 0;
        turtle.heading = 0;
        updateTurtle();
    });

    /* Examples */
    examplesEl.addEventListener('change', () => {
        const key = examplesEl.value;
        if (!key) return;

        codeEl.value = EXAMPLES[key];
        examplesEl.value = '';
        errorLine = null;
        renderGutter();
        setStatus('Example loaded');
    });

    /* Files */
    document.getElementById('saveProgramBtn').addEventListener('click', saveProgram);
    document.getElementById('saveImageBtn').addEventListener('click', savePicture);

    document.getElementById('loadProgramBtn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            codeEl.value = String(reader.result || '');
            errorLine = null;
            renderGutter();
            setStatus(`Opened: ${file.name}`);
        };
        reader.readAsText(file);
        fileInput.value = '';
    });

    /* Help */
    document.getElementById('helpBtn').addEventListener('click', () => {
        if (typeof helpDialog.showModal === 'function') helpDialog.showModal();
        else helpDialog.setAttribute('open', '');
    });

    document.getElementById('helpClose').addEventListener('click', () => helpDialog.close());

    helpDialog.addEventListener('click', (event) => {
        if (event.target === helpDialog) helpDialog.close();
    });

    /* Fullscreen */
    document.getElementById('fullscreenBtn').addEventListener('click', () => {
        if (!document.fullscreenElement) {
            appEl.requestFullscreen?.().catch(() => setStatus('Fullscreen unavailable'));
        } else {
            document.exitFullscreen?.();
        }
    });

    /* Stop */
    stopBtn.addEventListener('click', () => {
        if (running) setStatus('Stopping…', 'running');
    });
}

if (typeof document !== 'undefined' && document.getElementById && typeof appEl !== 'undefined') {
    init();
} else {
    globalThis.runProgram = runProgram;
    globalThis.execTokens = execTokens;
    globalThis.tokenize = tokenize;
    globalThis.turtle = turtle;
    globalThis.scene = scene;
    globalThis.clearDrawing = clearDrawing;
    globalThis.procedures = procedures;
    globalThis.stopProgram = () => { abortFlag = true; };
}
