// voice-server.js — WebSocket relay between the browser and Gemini Live.
//
// The browser streams mic audio (16kHz PCM16) + whiteboard video frames (JPEG)
// over a WebSocket to /voice; this relay forwards them to a Gemini Live session
// (keeping GEMINI_API_KEY server-side) and streams the model's audio/text back.
//
// Requires are guarded so a missing `ws` / `@google/genai` disables voice mode
// rather than crashing the server.

let WebSocketServer = null;
try {
    ({ WebSocketServer } = require('ws'));
} catch (e) {
    console.warn('⚠️  `ws` not installed — voice mode disabled. Run `npm install`.');
}

let GoogleGenAI = null;
let Modality = null;
let Type = null;
try {
    ({ GoogleGenAI, Modality, Type } = require('@google/genai'));
} catch (e) {
    // @google/genai missing — handled below.
}

// Canvas tools the assistant can call. Coordinates/sizes are percentages (0-100)
// of the board; the browser converts them and executes via Fabric.
const TOOLS = Type ? [{
    functionDeclarations: [
        { name: 'draw_line', description: 'Draw a straight line. x1,y1,x2,y2 are percentages 0-100 of the board (origin top-left). Optional color (CSS name or hex) and strokeWidth (px).', parameters: { type: Type.OBJECT, properties: { x1: { type: Type.NUMBER }, y1: { type: Type.NUMBER }, x2: { type: Type.NUMBER }, y2: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER } }, required: ['x1', 'y1', 'x2', 'y2'] } },
        { name: 'draw_rect', description: 'Draw a rectangle by top-left corner (x,y) and size (width,height), all percent 0-100. Optional: color (outline), strokeWidth (px), fill (CSS name/hex; omit for transparent), fillOpacity (0-1), cornerRadius (px, for rounded corners).', parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, cornerRadius: { type: Type.NUMBER } }, required: ['x', 'y', 'width', 'height'] } },
        { name: 'draw_ellipse', description: 'Draw an ellipse/circle filling the bounding box at (x,y) with size (width,height), percent 0-100. Optional: color (outline), strokeWidth (px), fill (CSS name/hex; omit for transparent), fillOpacity (0-1).', parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER } }, required: ['x', 'y', 'width', 'height'] } },
        { name: 'draw_arrow', description: 'Draw an arrow from (x1,y1) to (x2,y2), percent 0-100. Optional color and strokeWidth (px).', parameters: { type: Type.OBJECT, properties: { x1: { type: Type.NUMBER }, y1: { type: Type.NUMBER }, x2: { type: Type.NUMBER }, y2: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER } }, required: ['x1', 'y1', 'x2', 'y2'] } },
        { name: 'draw_polyline', description: 'Draw a connected multi-segment line (or a closed polygon) through a list of points, each {x,y} in percent 0-100. Its vertices are editable. Set closed=true for a filled/closed polygon. Vertices placed near an existing shape\'s edge automatically anchor to it and follow that shape when it moves (pass anchor=false to disable). Optional: color (outline), strokeWidth (px), fill + fillOpacity (polygons only), closed, anchor.', parameters: { type: Type.OBJECT, properties: { points: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] } }, closed: { type: Type.BOOLEAN }, anchor: { type: Type.BOOLEAN }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER } }, required: ['points'] } },
        { name: 'draw_polygon', description: 'Draw a closed polygon through a list of points, each {x,y} in percent 0-100 (a draw_polyline with closed=true). Vertices are editable and anchor to nearby shapes. Optional: color, strokeWidth, fill, fillOpacity, anchor.', parameters: { type: Type.OBJECT, properties: { points: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] } }, anchor: { type: Type.BOOLEAN }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER } }, required: ['points'] } },
        { name: 'write_text', description: "Write text. EITHER give x,y percent (top-left; size optional, percent of board height, default 6) OR give boxId (a shape's id) to auto-center and auto-size the text to fit nicely inside that shape — ALWAYS prefer boxId when putting a label inside a box/ellipse. Optional color (CSS name or hex).", parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, text: { type: Type.STRING }, size: { type: Type.NUMBER }, color: { type: Type.STRING }, boxId: { type: Type.STRING } }, required: ['text'] } },
        { name: 'plot_function', description: 'Plot a math.js expression as a graph, e.g. expression "x^2+3*x". variable default x, xmin/xmax default -10/10.', parameters: { type: Type.OBJECT, properties: { expression: { type: Type.STRING }, variable: { type: Type.STRING }, xmin: { type: Type.NUMBER }, xmax: { type: Type.NUMBER } }, required: ['expression'] } },
        { name: 'get_objects', description: 'List everything on the board with its id and EXACT position/size in percent (0-100): id, type, x, y, width, height. Call this to get the id of an existing shape before adjusting it, or before drawing something that must align with one.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'erase_at', description: 'Delete a shape. Provide its id (preferred), or x,y percent of its location if you have no id.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER } } } },
        { name: 'move_object', description: 'Move a shape by (dx,dy) percent. Target it by id (preferred) or by x,y location.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, dx: { type: Type.NUMBER }, dy: { type: Type.NUMBER } }, required: ['dx', 'dy'] } },
        { name: 'resize_object', description: 'Resize a shape by factor (1.5 = 50% bigger, 0.5 = half). Target by id (preferred) or x,y.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, factor: { type: Type.NUMBER } }, required: ['factor'] } },
        { name: 'set_color', description: "Change a shape's color. Target by id (preferred) or x,y. color is a CSS name or hex (e.g. 'red', '#1565c0').", parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, color: { type: Type.STRING } }, required: ['color'] } },
        { name: 'style_object', description: "Change a shape's properties (any subset): color (outline / text colour), strokeWidth (px), fill (CSS name/hex; 'none' to clear), fillOpacity (0-1), cornerRadius (px, rectangles only). Target by id (preferred) or x,y.", parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, cornerRadius: { type: Type.NUMBER } } } },
        { name: 'duplicate_object', description: 'Make a pixel-exact copy of a shape (same size, aspect), offset by (dx,dy) percent. Target by id (preferred) or x,y. Returns the copy\'s id.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, dx: { type: Type.NUMBER }, dy: { type: Type.NUMBER } }, required: ['dx', 'dy'] } },
        { name: 'clear_board', description: 'Erase everything on the board.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'calibrate_start', description: 'Start a placement-accuracy calibration round: draws red target crosses and a dashed blue text box on the board. Follow the returned instructions (draw a small ellipse on each cross, write CAL in the box, then call calibrate_check). Run when the user asks you to calibrate.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'calibrate_check', description: 'Finish a calibration round: measures how far your marks landed from the targets, prints a report to the output panel, cleans the board, and returns the error stats plus advice on whether to retry.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'analyze_equation', description: "Read the user's handwritten equation off the board (vision OCR), replace the handwriting with clean typed text in place, and remember it for solving/plotting. Call this when the user asks you to read, analyze, or work with what they wrote. Returns the recognized equation.", parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'solve_equation', description: 'Solve an equation and write the answer on the board below the equation. expression is optional math.js syntax (e.g. "x^2-4*x+16"); if omitted, the last analyzed equation is used. Solves expression = 0.', parameters: { type: Type.OBJECT, properties: { expression: { type: Type.STRING } } } },
        { name: 'show_steps', description: "Write a step-by-step solution on the board below the equation. expression is optional (defaults to the last analyzed equation). method is optional, e.g. 'the p-q formula', 'the quadratic formula', 'completing the square', 'factoring'. Solves expression = 0.", parameters: { type: Type.OBJECT, properties: { expression: { type: Type.STRING }, method: { type: Type.STRING } } } },
    ],
}] : null;

// The Live model id differs by API provider, and simultaneous video+audio+tools
// works best on 3.x-Flash live models (per Google's own guidance); native-audio
// models reject tool calls entirely. Try the most capable tool-friendly models
// first, falling back through 2.5 half-cascade to native-audio (voice only).
// Override with GEMINI_LIVE_MODEL to pin one.
const CANDIDATE_MODELS = process.env.GEMINI_LIVE_MODEL
    ? [process.env.GEMINI_LIVE_MODEL]
    : [
        'gemini-3.5-flash-live-preview',                  // 3.5 — best at video+audio+tools
        'gemini-live-3.5-flash-preview',
        'gemini-3.1-flash-live-preview',
        'gemini-live-2.5-flash-preview',                  // half-cascade — strong tool calling
        'gemini-2.5-flash-live-preview',
        'gemini-2.0-flash-live-001',                      // half-cascade fallback
        'gemini-2.5-flash-native-audio-preview-12-2025',  // native audio (great voice, no tools)
        'gemini-2.5-flash-preview-native-audio-dialog',
        'gemini-live-2.5-flash-native-audio',
    ];

const SYSTEM_INSTRUCTION = `You are a friendly, concise voice tutor and drawing collaborator on a shared math whiteboard.
You can see the user's drawing (it streams to you as video), hear them speak, AND draw on the board yourself using the provided tools.
You can draw lines, rectangles (optionally rounded), ellipses, arrows, text, and multi-segment polylines/polygons; plot functions; and erase, move, resize, recolour, or restyle existing objects.
Shapes can carry style: pass color (outline), strokeWidth, fill + fillOpacity (rectangles, ellipses, polygons), and cornerRadius (rectangles). Use draw_polyline (or draw_polygon, or draw_polyline with closed=true) for connected segments and closed shapes; its vertices are editable and any vertex placed near an existing shape's edge automatically anchors to it, so the connector follows that shape when it's moved. Use style_object to change fill/opacity/stroke/corners of an existing shape.
You can also work with the user's handwritten math: call analyze_equation to read what they wrote (it converts the handwriting to clean text in place and returns the equation), then solve_equation or show_steps to write the answer or a step-by-step solution onto the board (these read the last analyzed equation when no expression is given). For show_steps you may pass a method like "the p-q formula" or "factoring" when the user asks for a specific one. Prefer these tools over hand-writing math yourself, so the result is rendered consistently.
All tool coordinates and sizes are percentages from 0 to 100 of the board, with the origin at the top-left.
The board image you see has a faint blue coordinate grid: the numbers 0-100 along the top are the x axis, and 0-100 down the left edge are the y axis. READ positions and sizes directly off this grid — don't guess. The grid cells are usually NOT square (the board is wider than tall), so to match a shape's proportions, read its width along the x axis and its height along the y axis separately; they will be different numbers even for a square.
When the user asks you to draw, sketch, plot, erase, move, or resize something, CALL THE APPROPRIATE TOOL rather than only describing it. You may call several tools in sequence to compose a drawing.
EVERY shape has a stable id. When you draw a shape, the tool result returns its id — REMEMBER it so you can adjust THAT exact shape later (move_object, resize_object, set_color, erase_at, duplicate_object) by passing its id. Do NOT re-estimate a shape's location to adjust it; use its id. To adjust a shape you did not just draw, call get_objects first to find its id.
Targeting by id is exact; targeting by x,y is only a fallback when you have no id.
Whenever a new drawing must align with, match, or be positioned relative to something already on the board, FIRST call get_objects to read exact coordinates, then draw using those numbers. To replicate a shape the user drew, prefer duplicate_object (a pixel-exact copy).
Every draw/move/resize tool result includes the shape's ACTUAL bounding box in percent — compare it against what you intended, and if it's off, correct it immediately with move_object/resize_object using the exact numbers. To put a label inside a box or ellipse, ALWAYS use write_text with boxId — never eyeball text into a shape.
CALIBRATION: when the user asks you to calibrate (e.g. "calibrate", "self-calibrate", "tune your aim"), run this loop: (1) call calibrate_start; (2) study the NEXT video frame, then draw a small ellipse (about 3x3) centered on each red cross, reading each position off the grid, and write the word CAL fitted inside the dashed blue rectangle by eye (do NOT use boxId here — this measures your vision); (3) call calibrate_check. If its advice says to retry, apply the reported (dx, dy) bias as a correction to your aim and repeat from step 1, at most 3 rounds. Finish by telling the user the mean error in one short sentence — the full report is already in the output panel.
Keep spoken answers short. When the drawing is ambiguous (e.g. a digit you can't read), ask a brief clarifying question.
The very first message you receive will be the single word "BEGIN". When you see it, greet the user in one short sentence and invite them to draw or ask — and do not mention the word BEGIN.`;

const LIVE_CONFIG = {
    systemInstruction: SYSTEM_INSTRUCTION,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    ...(TOOLS ? { tools: TOOLS } : {}),
};

function attachVoiceServer(server) {
    if (!WebSocketServer) return; // ws unavailable

    const wss = new WebSocketServer({ server, path: '/voice' });
    wss.on('error', () => {}); // EADDRINUSE etc. handled by the http server

    wss.on('connection', async (browserWs) => {
        const send = (obj) => {
            if (browserWs.readyState === 1) browserWs.send(JSON.stringify(obj));
        };

        const apiKey = process.env.GEMINI_API_KEY;
        if (!GoogleGenAI || !apiKey) {
            send({ type: 'error', message: 'Gemini Live is not configured on the server.' });
            browserWs.close();
            return;
        }

        const ai = new GoogleGenAI({ apiKey });
        let committed = false; // only forward model output once we've picked a working session

        // Forward a Gemini server message to the browser.
        const forward = (msg) => {
            if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
                send({
                    type: 'tool_call',
                    calls: msg.toolCall.functionCalls.map((fc) => ({ id: fc.id, name: fc.name, args: fc.args || {} })),
                });
            }
            const sc = msg.serverContent;
            if (!sc) return;
            const parts = sc.modelTurn && sc.modelTurn.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.data) send({ type: 'audio', data: part.inlineData.data });
                    // Skip part.text — it carries the model's internal "thinking",
                    // not the spoken answer. The transcript uses outputTranscription.
                }
            }
            if (sc.outputTranscription && sc.outputTranscription.text) {
                send({ type: 'text', role: 'model', data: sc.outputTranscription.text });
            }
            if (sc.inputTranscription && sc.inputTranscription.text) {
                send({ type: 'text', role: 'user', data: sc.inputTranscription.text });
            }
            if (sc.interrupted) send({ type: 'interrupted' });
            if (sc.turnComplete) send({ type: 'turn_complete' });
        };

        // Try to open a Live session with one model; resolves with the session on
        // setupComplete, rejects if it errors/closes before becoming ready.
        const connectModel = (model) => new Promise((resolve, reject) => {
            let settled = false;
            let theSession = null;
            const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
            ai.live
                .connect({
                    model,
                    config: { responseModalities: [Modality.AUDIO], ...LIVE_CONFIG },
                    callbacks: {
                        onopen: () => {},
                        onmessage: (msg) => {
                            if (msg.setupComplete) settle(resolve, theSession);
                            if (committed) forward(msg);
                        },
                        onerror: (e) => {
                            const m = (e && e.message) || String(e);
                            if (!settled) settle(reject, new Error(m));
                            else send({ type: 'error', message: m });
                        },
                        onclose: (e) => {
                            const r = (e && e.reason) || '';
                            if (!settled) settle(reject, new Error('closed before ready' + (r ? ': ' + r : '')));
                            else send({ type: 'closed', message: r });
                        },
                    },
                })
                .then((s) => { theSession = s; })
                .catch((e) => settle(reject, e));
            setTimeout(() => settle(reject, new Error('timed out')), 8000);
        });

        let session = null;
        let workingModel = null;
        let lastErr = null;
        for (const model of CANDIDATE_MODELS) {
            try {
                const s = await connectModel(model);
                if (s) { session = s; workingModel = model; break; }
                lastErr = new Error('no session returned');
            } catch (e) {
                lastErr = e;
                console.warn(`Live model "${model}" failed: ${e.message}`);
            }
        }

        if (!session) {
            send({
                type: 'error',
                message:
                    'Could not start a Gemini Live session. Tried: ' + CANDIDATE_MODELS.join(', ') +
                    '. Last error: ' + (lastErr && lastErr.message) + '. Set GEMINI_LIVE_MODEL to a valid Live model.',
            });
            browserWs.close();
            return;
        }

        committed = true;
        console.log('🎤 Voice session connected (model: ' + workingModel + ')');
        send({ type: 'ready' });
        send({ type: 'info', message: 'Connected — model: ' + workingModel });
        try { session.sendRealtimeInput({ text: 'BEGIN' }); } catch (e) { /* noop */ } // make the model greet first

        browserWs.on('message', (raw) => {
            let m;
            try { m = JSON.parse(raw.toString()); } catch (e) { return; }
            try {
                if (m.type === 'audio') {
                    session.sendRealtimeInput({ audio: { data: m.data, mimeType: 'audio/pcm;rate=16000' } });
                } else if (m.type === 'video') {
                    session.sendRealtimeInput({ video: { data: m.data, mimeType: 'image/jpeg' } });
                } else if (m.type === 'text') {
                    session.sendRealtimeInput({ text: m.data });
                } else if (m.type === 'tool_response' && Array.isArray(m.responses)) {
                    session.sendToolResponse({
                        functionResponses: m.responses.map((r) => ({ id: r.id, name: r.name, response: r.result || {} })),
                    });
                } else if (m.type === 'stop') {
                    try { session.close(); } catch (e) { /* noop */ }
                }
            } catch (e) {
                send({ type: 'error', message: e.message });
            }
        });

        browserWs.on('close', () => {
            try { if (session) session.close(); } catch (e) { /* noop */ }
        });
    });

    console.log('🎤 Voice relay listening on ws path /voice');
}

module.exports = { attachVoiceServer };
