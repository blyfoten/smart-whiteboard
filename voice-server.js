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

// The backend coding agent behind debug mode. Its tools are handled HERE in the
// relay (not in the browser): the repository lives on the server and must stay
// there. Declarations are only offered to the model when the feature is actually
// available — see debug-routes.js for the DEBUG_AGENT_ENABLED gate.
const debugSessions = require('./debug/sessions');
const { available: debugAvailable, unavailableReason: debugUnavailableReason } = require('./debug-routes');

// Canvas tools the assistant can call. Coordinates/sizes are percentages (0-100)
// of the board; the browser converts them and executes via Fabric.
const CANVAS_TOOLS = Type ? [
        { name: 'draw_line', description: "Draw a straight line. x1,y1,x2,y2 are percentages 0-100 of the board (origin top-left). Optional color (CSS name or hex), strokeWidth (px), lineStyle ('solid' | 'dashed' | 'dotted' — also on rect/ellipse/arrow/polyline).", parameters: { type: Type.OBJECT, properties: { x1: { type: Type.NUMBER }, y1: { type: Type.NUMBER }, x2: { type: Type.NUMBER }, y2: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['x1', 'y1', 'x2', 'y2'] } },
        { name: 'draw_rect', description: 'Draw a rectangle of size (width,height) percent. Position it EITHER by center (cx,cy — preferred when centering on/around something) OR by top-left corner (x,y). Optional: color (outline), strokeWidth (px), fill (CSS name/hex; omit for transparent), fillOpacity (0-1), cornerRadius (px, for rounded corners).', parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, cx: { type: Type.NUMBER }, cy: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, cornerRadius: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['width', 'height'] } },
        { name: 'draw_ellipse', description: 'Draw an ellipse/circle of size (width,height) percent. Position it EITHER by center (cx,cy — preferred; e.g. a circle AT a point) OR by the bounding box top-left (x,y). Optional: color (outline), strokeWidth (px), fill (CSS name/hex; omit for transparent), fillOpacity (0-1).', parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, cx: { type: Type.NUMBER }, cy: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['width', 'height'] } },
        { name: 'draw_arrow', description: 'Draw an arrow from (x1,y1) to (x2,y2), percent 0-100. Optional color and strokeWidth (px).', parameters: { type: Type.OBJECT, properties: { x1: { type: Type.NUMBER }, y1: { type: Type.NUMBER }, x2: { type: Type.NUMBER }, y2: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['x1', 'y1', 'x2', 'y2'] } },
        { name: 'draw_polyline', description: 'Draw a connected multi-segment line (or a closed polygon) through a list of points, each {x,y} in percent 0-100. Its vertices are editable. Set closed=true for a filled/closed polygon. Vertices placed near an existing shape\'s edge automatically anchor to it and follow that shape when it moves (pass anchor=false to disable). Optional: color (outline), strokeWidth (px), fill + fillOpacity (polygons only), closed, anchor.', parameters: { type: Type.OBJECT, properties: { points: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] } }, closed: { type: Type.BOOLEAN }, anchor: { type: Type.BOOLEAN }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['points'] } },
        { name: 'draw_polygon', description: 'Draw a closed polygon through a list of points, each {x,y} in percent 0-100 (a draw_polyline with closed=true). Vertices are editable and anchor to nearby shapes. Optional: color, strokeWidth, fill, fillOpacity, anchor.', parameters: { type: Type.OBJECT, properties: { points: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] } }, anchor: { type: Type.BOOLEAN }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['points'] } },
        { name: 'write_text', description: "Write text. Position it ONE of three ways: boxId (a shape's id — auto-centers and auto-sizes the text to fit inside that shape; ALWAYS use this for a label inside a box/ellipse), cx,cy percent (the text's CENTER — use when centering on a point), or x,y percent (the text's TOP-LEFT corner: the text hangs BELOW-RIGHT of x,y, so passing a shape's center as x,y puts the label half outside the shape — never use x,y for labels). size is optional (percent of board height, default 6). Optional color (CSS name or hex).", parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, cx: { type: Type.NUMBER }, cy: { type: Type.NUMBER }, text: { type: Type.STRING }, size: { type: Type.NUMBER }, color: { type: Type.STRING }, boxId: { type: Type.STRING }, fromVideo: { type: Type.BOOLEAN } }, required: ['text'] } },
        { name: 'plot_function', description: 'Plot a math.js expression as a graph, e.g. expression "x^2+3*x". variable default x, xmin/xmax default -10/10.', parameters: { type: Type.OBJECT, properties: { expression: { type: Type.STRING }, variable: { type: Type.STRING }, xmin: { type: Type.NUMBER }, xmax: { type: Type.NUMBER } }, required: ['expression'] } },
        { name: 'get_objects', description: 'List everything on the board with its id and EXACT geometry in percent (0-100): id, type, x, y (top-left), width, height, plus text for labels. This is your eyes on the real state — call it before adjusting a shape, before drawing something that must align with one, and again AFTER a multi-step change to check the result. You can also filter the list by geometry to pick out a subset (e.g. tall connectors = height much greater than width).', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'erase_at', description: 'Delete a shape. Provide its id (preferred), or x,y percent of its location if you have no id.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER } } } },
        { name: 'move_object', description: 'Move a shape. Either place it ABSOLUTELY with toCx,toCy (where its CENTRE should end up, percent 0-100 — use this for laying out or rearranging a diagram), or nudge it RELATIVELY with dx,dy percent. Target it by id (preferred) or by x,y location.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, dx: { type: Type.NUMBER }, dy: { type: Type.NUMBER }, toCx: { type: Type.NUMBER }, toCy: { type: Type.NUMBER } } } },
        { name: 'resize_object', description: 'Resize a shape by factor (1.5 = 50% bigger, 0.5 = half). Target by id (preferred) or x,y.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, factor: { type: Type.NUMBER } }, required: ['factor'] } },
        { name: 'set_color', description: "Change a shape's color. Target by id (preferred) or x,y. color is a CSS name or hex (e.g. 'red', '#1565c0').", parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, color: { type: Type.STRING } }, required: ['color'] } },
        { name: 'style_object', description: "Change a shape's properties (any subset): color (outline / text colour), strokeWidth (px), lineStyle ('solid' | 'dashed' | 'dotted'), fill (CSS name/hex; 'none' to clear), fillOpacity (0-1; changing opacity alone keeps the current fill colour), cornerRadius (px, rectangles only). Target by id (preferred) or x,y.", parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, color: { type: Type.STRING }, strokeWidth: { type: Type.NUMBER }, lineStyle: { type: Type.STRING }, fill: { type: Type.STRING }, fillOpacity: { type: Type.NUMBER }, cornerRadius: { type: Type.NUMBER } } } },
        { name: 'reorder_object', description: "Change a shape's stacking order when shapes overlap. mode: 'front' (top), 'back' (bottom), 'forward' (one step up), 'backward' (one step down). Target by id (preferred) or x,y.", parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, mode: { type: Type.STRING } }, required: ['mode'] } },
        { name: 'duplicate_object', description: 'Make a pixel-exact copy of a shape (same size, aspect), offset by (dx,dy) percent. Target by id (preferred) or x,y. Returns the copy\'s id.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, dx: { type: Type.NUMBER }, dy: { type: Type.NUMBER } }, required: ['dx', 'dy'] } },
        { name: 'clear_board', description: 'Erase everything on the board.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'calibrate_start', description: 'Start a placement-accuracy calibration round: draws red target crosses and a dashed blue text box on the board. Follow the returned instructions (draw a small ellipse on each cross, write CAL in the box, then call calibrate_check). Run when the user asks you to calibrate.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'calibrate_check', description: 'Finish a calibration round: measures how far your marks landed from the targets, prints a report to the output panel, cleans the board, and returns the error stats plus advice on whether to retry. IMPORTANT: pass appliedCorrection=true if you aimed this round using a correction model (from earlier advice or a session note) — the new measurement is then composed on top of it instead of replacing it. Pass keep=true to leave the targets and your marks visible on the board (e.g. when the user wants a screenshot); they are swept by the next calibrate_start.', parameters: { type: Type.OBJECT, properties: { keep: { type: Type.BOOLEAN }, appliedCorrection: { type: Type.BOOLEAN } } } },
        { name: 'calibrate_reset', description: 'Clear the stored placement-calibration model (fromVideo placements become uncorrected). Call when the user asks to reset/forget the calibration, or when calibration results look absurd across rounds.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'analyze_equation', description: "Read the user's handwritten equation off the board (vision OCR), replace the handwriting with clean typed text in place, and remember it for solving/plotting. Call this when the user asks you to read, analyze, or work with what they wrote. Returns the recognized equation.", parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'solve_equation', description: 'Solve an equation and write the answer on the board below the equation. expression is optional math.js syntax (e.g. "x^2-4*x+16"); if omitted, the last analyzed equation is used. Solves expression = 0.', parameters: { type: Type.OBJECT, properties: { expression: { type: Type.STRING } } } },
        { name: 'show_steps', description: "Write a step-by-step solution on the board below the equation. expression is optional (defaults to the last analyzed equation). method is optional, e.g. 'the p-q formula', 'the quadratic formula', 'completing the square', 'factoring'. Solves expression = 0.", parameters: { type: Type.OBJECT, properties: { expression: { type: Type.STRING }, method: { type: Type.STRING } } } },
        // --- CAD (parametric sketch) tools. Geometry positions are board percent;
        // dimension values & parameters are SKETCH UNITS (cad_get_sketch returns
        // unitsPerPercent for converting). Every cad_* result reports solve status
        // (ok / conflict) and remaining degrees of freedom.
        { name: 'cad_sketch_line', description: 'CAD: add a parametric line segment from (x1,y1) to (x2,y2), percent 0-100. Endpoints that land near an existing sketch point merge with it (coincident); exactly-horizontal/vertical input gets an auto H/V constraint. Returns lineIds and pointIds — REMEMBER them for constraining/dimensioning.', parameters: { type: Type.OBJECT, properties: { x1: { type: Type.NUMBER }, y1: { type: Type.NUMBER }, x2: { type: Type.NUMBER }, y2: { type: Type.NUMBER } }, required: ['x1', 'y1', 'x2', 'y2'] } },
        { name: 'cad_sketch_polyline', description: 'CAD: add a connected chain of parametric line segments through points (each {x,y} percent). closed=true also closes the loop (polygon). Corner points are shared between segments; endpoints merge onto nearby existing sketch points. Returns lineIds and pointIds in order.', parameters: { type: Type.OBJECT, properties: { points: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] } }, closed: { type: Type.BOOLEAN } }, required: ['points'] } },
        { name: 'cad_sketch_rect', description: 'CAD: add a parametric rectangle — 4 lines sharing corner points with horizontal/vertical constraints already applied. Size width,height percent; position by center (cx,cy) or top-left (x,y). Returns lineIds (top, right, bottom, left) and pointIds (corners clockwise from top-left).', parameters: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, cx: { type: Type.NUMBER }, cy: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER } }, required: ['width', 'height'] } },
        { name: 'cad_sketch_circle', description: 'CAD: add a parametric circle at center (cx,cy) percent with radius in percent of board width. Returns the circle id and its center point id.', parameters: { type: Type.OBJECT, properties: { cx: { type: Type.NUMBER }, cy: { type: Type.NUMBER }, radius: { type: Type.NUMBER } }, required: ['cx', 'cy', 'radius'] } },
        { name: 'cad_sketch_arc', description: "CAD: add a parametric arc — center (cx,cy) percent, radius percent of board width, startAngleDeg/endAngleDeg measured from the positive x-axis (this canvas is y-down, so positive degrees sweep clockwise); the arc is drawn from start to end in that direction. Only the center and radius are adjustable afterward (equal/radius dimension work like a circle's); the endpoints are fixed by the angles given here. Returns the arc id and its center point id.", parameters: { type: Type.OBJECT, properties: { cx: { type: Type.NUMBER }, cy: { type: Type.NUMBER }, radius: { type: Type.NUMBER }, startAngleDeg: { type: Type.NUMBER }, endAngleDeg: { type: Type.NUMBER } }, required: ['cx', 'cy', 'radius', 'startAngleDeg', 'endAngleDeg'] } },
        { name: 'cad_get_sketch', description: 'CAD: list the parametric sketch — points (id, percent position, fixed?), entities (lines with endpoint ids + percent coords + lengthUnits; circles with center + radiusUnits; arcs with center + radiusUnits + start/endAngleDeg), constraints (dimensions carry expr and value), parameters, degreesOfFreedom, solve status, and unitsPerPercent (sketch units per 1% of board). ALWAYS call this to get ids before constraining/dimensioning geometry you did not just create.', parameters: { type: Type.OBJECT, properties: {} } },
        { name: 'cad_constrain', description: "CAD: apply a geometric constraint. type: 'horizontal' | 'vertical' (entityIds: 1+ lines), 'parallel' | 'perpendicular' (exactly 2 lines), 'equal' (2+ lines = equal length, or 2+ circles/arcs = equal radius), 'coincident' (pointIds: 2 points to merge, OR 1 point + 1 line entity = point-on-line), 'fix' (pointIds: toggle pin in place). The sketch re-solves immediately; check solve.ok in the result — if false the constraint conflicts, so cad_delete it.", parameters: { type: Type.OBJECT, properties: { type: { type: Type.STRING }, entityIds: { type: Type.ARRAY, items: { type: Type.STRING } }, pointIds: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['type'] } },
        { name: 'cad_dimension', description: "CAD: add a driving dimension and re-solve. Pass value as a number or an expression using parameters (e.g. '150', 'w/2'). Target: entityIds=[one line] → its length; pointIds=[two points] → distance; entityIds=[one circle or arc] → radius; entityIds=[two lines] → angle in degrees. To CHANGE an existing dimension pass dimId (from cad_get_sketch) and the new value instead. Lengths are in sketch units, not percent.", parameters: { type: Type.OBJECT, properties: { entityIds: { type: Type.ARRAY, items: { type: Type.STRING } }, pointIds: { type: Type.ARRAY, items: { type: Type.STRING } }, value: { type: Type.STRING }, dimId: { type: Type.STRING } }, required: ['value'] } },
        { name: 'cad_set_param', description: "CAD: create or update a named parameter, e.g. name 'w', value '200' or 'h*2' (expressions may reference other parameters). All dimensions using it re-solve immediately. Pass remove=true to delete the parameter instead.", parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, value: { type: Type.STRING }, remove: { type: Type.BOOLEAN } }, required: ['name'] } },
        { name: 'cad_delete', description: 'CAD: delete sketch entities and/or constraints (dimensions too) by id. Deleting an entity also removes its constraints and orphaned points. Use this to resolve an over-constrained conflict (solve.ok=false).', parameters: { type: Type.OBJECT, properties: { ids: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['ids'] } },
] : [];

// Debug / bug-fix mode. These are executed by the relay itself: start_debug_session
// packages what the user told you (plus a screenshot and the browser's captured
// errors) into a bug report and wakes the coding agent on a fresh git branch;
// debug_message is how the rest of the conversation reaches that agent.
const DEBUG_TOOLS = Type ? [
    {
        name: 'start_debug_session',
        description:
            "Hand a problem with the WHITEBOARD APP ITSELF over to the backend coding agent, which works on the app's git repository and can ship a fix while you keep talking. Use it when the user reports that the app is broken or behaving wrong (a button does nothing, a shape lands in the wrong place, an error appeared, a feature is missing) — NOT for anything about the contents of their drawing. Describe the problem as completely as you can from the conversation: this text is all the agent gets. A screenshot of the board and the browser's captured console errors are attached automatically. After this call you are in debug mode: relay what the user says with debug_message.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                title: { type: Type.STRING, description: 'Short name for the bug, e.g. "Undo does not restore erased shapes". Becomes the branch name.' },
                summary: { type: Type.STRING, description: 'What is wrong, in a sentence or two, in your own words.' },
                stepsToReproduce: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'What the user did, in order, as far as you know it.' },
                expected: { type: Type.STRING, description: 'What should have happened.' },
                actual: { type: Type.STRING, description: 'What actually happened.' },
                area: { type: Type.STRING, description: "Which part of the app: 'voice', 'cad', 'canvas', 'shapes', 'graph', 'math', 'boards', 'ui', 'server' — or your own word if none fit." },
                severity: { type: Type.STRING, description: "'blocker' | 'major' | 'minor' | 'cosmetic'." },
                suspectedFiles: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional: files you suspect, if the user or the errors point somewhere specific.' },
                userQuote: { type: Type.STRING, description: "The user's own words about the problem, verbatim — the agent reads them too." },
                wanted: { type: Type.STRING, description: 'What the user asked for, if they asked for a specific change rather than just reporting a fault.' },
                includeScreenshot: { type: Type.BOOLEAN, description: 'Attach the current board image. Default true; set false only if the board is irrelevant.' },
            },
            required: ['title', 'summary'],
        },
    },
    {
        name: 'debug_message',
        description:
            "Send the user's words to the coding agent working on the fix, and get an immediate acknowledgement (the agent's actual progress arrives as spoken updates, so do not wait for it). While a debug session is open, EVERYTHING the user says about the problem, the fix, or what to do next goes through this tool — answer questions about the code by asking the agent, not from your own guesses. Restate faithfully and completely, including any new detail, correction or answer to a question the agent asked.",
        parameters: {
            type: Type.OBJECT,
            properties: { text: { type: Type.STRING, description: "What to tell the agent — the user's intent in full, not a summary." } },
            required: ['text'],
        },
    },
    {
        name: 'debug_status',
        description: 'Check on the coding agent: whether it is working or idle, the branch, files changed, commits pushed, and its last summary. Use it when the user asks how it is going, or before you claim anything about the state of the fix.',
        parameters: { type: Type.OBJECT, properties: {} },
    },
    {
        name: 'end_debug_session',
        description: "Leave debug mode and go back to being the whiteboard assistant. Any uncommitted work is committed and pushed to the session's branch first (pass push=false to leave it in the working tree). Call this when the user says they are done debugging.",
        parameters: { type: Type.OBJECT, properties: { push: { type: Type.BOOLEAN } } },
    },
] : [];

const DEBUG_TOOL_NAMES = new Set(DEBUG_TOOLS.map((t) => t.name));

// Gemini takes tools as a single functionDeclarations block; debug tools are
// only included when the server can actually run them.
function buildTools(includeDebug) {
    if (!Type) return null;
    return [{ functionDeclarations: includeDebug ? CANVAS_TOOLS.concat(DEBUG_TOOLS) : CANVAS_TOOLS }];
}

// The Live model id differs by API provider, and simultaneous video+audio+tools
// works best on the Flash *live* models; native-audio models reject tool calls
// entirely. Try the most capable tool-friendly models first, falling back to
// native-audio (voice only). Each miss costs an 8s connect timeout, so the list
// holds models Google actually documents rather than speculative names.
//
// NOTE: the Live API tracks the main model line separately — as of 2026-08 the
// newest live model is 3.1-Flash-Live even though the text/vision default is
// now gemini-3.7-flash. When a newer live preview ships, put it first here (or
// just set GEMINI_LIVE_MODEL, no code change needed).
const CANDIDATE_MODELS = process.env.GEMINI_LIVE_MODEL
    ? [process.env.GEMINI_LIVE_MODEL]
    : [
        'gemini-3.1-flash-live-preview',                       // newest live model: video+audio+tools
        'gemini-live-2.5-flash-preview',                       // half-cascade — strong tool calling
        'gemini-2.5-flash-live-preview',
        'gemini-live-2.5-flash-preview-native-audio-09-2025',  // native audio (great voice, no tools)
        'gemini-2.5-flash-native-audio-preview-12-2025',
    ];

const SYSTEM_INSTRUCTION = `You are a friendly, concise voice tutor and drawing collaborator on a shared whiteboard.
You can see the user's board (it streams to you as video), hear them speak, AND draw on it yourself using the provided tools.

WHAT YOU CAN PUT ON THE BOARD
- Plain shapes: lines, rectangles (optionally rounded), ellipses, arrows, text, and multi-segment polylines/polygons. These are ink — they sit exactly where you put them. Style with color (outline), strokeWidth, lineStyle (solid/dashed/dotted), fill + fillOpacity, cornerRadius; change an existing shape with style_object; restack overlapping shapes with reorder_object. A polyline vertex placed near a shape's edge anchors to it and follows that shape when it moves, which is what makes connectors stay attached.
- Parametric CAD geometry (the cad_* tools): points, lines and circles held together by constraints and driven by dimensions and named parameters, like Fusion or SolveSpace. Reach for this whenever sizes, angles or relationships must be exact, or must stay true when something later changes.
- Maths: analyze_equation reads the user's handwriting into clean text in place; solve_equation and show_steps write the answer or a worked solution onto the board; plot_function graphs an expression. Prefer these over hand-writing maths yourself, so results render consistently. For show_steps you may pass a method like "the p-q formula" or "factoring".

All tool coordinates and sizes are percentages from 0 to 100 of the board, origin top-left.
The board image you see has a faint blue coordinate grid: x runs 0-100 with numbers along the top AND bottom edges, y runs 0-100 with numbers along the left AND right edges. Strong numbered lines mark the 10s; thin faint lines mark the 5s (5, 15, 25...). READ positions and sizes directly off this grid — don't guess, and estimate to the nearest 1 (a point can lie on a thin 5-line or anywhere between lines). The grid cells are usually NOT square (the board is wider than tall), so to match a shape's proportions, read its width along the x axis and its height along the y axis separately; they will be different numbers even for a square.

HOW TO WORK: plan, act, verify, correct.
1. PLAN FIRST. For anything involving more than one shape, decide the whole arrangement — positions, sizes, spacing, alignment — before you draw. Drawing shape by shape and hoping produces crooked, drifting results.
2. READ BEFORE YOU TOUCH. get_objects lists every object with its id, type, text and EXACT position and size in percent; cad_get_sketch does the same for CAD geometry. Call it before you modify, align to, or reason about anything already on the board. Reading is cheap; guessing is not.
3. ACT IN BATCHES. Call as many tools in a row as the job needs — you do not have to stop and speak between them, and you should not narrate each call.
4. VERIFY WITH DATA, NOT VIBES. After a multi-step change, call get_objects again and compare the board against what you intended: are things that should be equal actually equal, are edges aligned, is anything overlapping that should not be, is anything off-board (x or y outside 0-100)? Fix what is off, then re-check. Do this before telling the user you are done.
5. BE HONEST ABOUT GAPS. If part of the request is not possible with these tools, say which part and what you did instead — never silently skip it.

PICKING OUT A SUBSET. Because get_objects returns geometry, you can select objects by property instead of asking the user which ones they meant: "the tall connectors" are objects whose height is much greater than their width, "the boxes on the left" have x below some cut, "the labels" are the ones with text. Filter the list yourself, then act on each id.

RECIPES
- BULK RESTYLE ("make the tall connections red and dashed"): get_objects, filter by geometry, then style_object on each matching id with color and lineStyle. Tell the user how many you changed.
- CLEAN REDRAW ("redraw this but neater and aligned"): get_objects to capture every shape and its role; work out a tidy version — shared baselines, equal gaps, one size for things that mean the same, coordinates rounded to a sensible step; draw the clean shapes; erase the originals by id with erase_at; verify with get_objects. You are straightening the user's drawing, not redesigning it: keep their layout and meaning.
- LAYOUT / REORDER ("rearrange so the arrows cross less"): get_objects, then work out which shapes are nodes and which are connectors, and which nodes each connector joins (compare endpoints against boxes). Choose a better arrangement — put connected nodes near each other, run the flow left-to-right or top-to-bottom in dependency order, keep spacing even. Then MOVE THE NODES with move_object; anchored connectors follow their shapes automatically. Verify afterwards, and if two connectors still cross, swap the two nodes involved and re-check.
- TECHNICAL DRAWING AT REAL SIZES ("make the walls 20 thick, add doors and windows"): use CAD. There is no offset or thickness tool — a wall of thickness t is two parallel lines t apart, so COMPUTE the second line's endpoints yourself and draw them with cad_sketch_line, then cad_constrain them parallel. An opening is a gap: draw the wall as segments that stop either side of the door or window, and add the door swing as an arc-like polyline or the window as a thin rectangle between the faces. Put the thickness in a parameter (cad_set_param) and dimension from it, so the whole plan can be re-thicknessed later by changing one number. Watch solve.ok and degreesOfFreedom as you go.
- TEACH WITH A DIAGRAM ("how do I work out the trajectory of an asteroid passing Earth?"): answer as a tutor who draws. Lay the board out deliberately — a short title top-left, the diagram in the middle, the governing equations down one side. Draw the situation (bodies, distances, the path as a polyline or a plotted curve), keeping relative sizes and distances honest where you can, and label everything with write_text using boxId or cx,cy. Write the equations that matter, then use plot_function for curves and solve_equation or show_steps where there is something to actually solve. If you need numbers the user has not given (masses, closest approach, speed), ask for them in one short question, then substitute and show the result. Say the idea out loud in a sentence or two and let the board carry the detail.

EVERY shape has a stable id. When you draw a shape, the tool result returns its id — REMEMBER it so you can adjust THAT exact shape later (move_object, resize_object, set_color, erase_at, duplicate_object) by passing its id. Do NOT re-estimate a shape's location to adjust it; use its id. To adjust a shape you did not just draw, call get_objects first to find its id.
Targeting by id is exact; targeting by x,y is only a fallback when you have no id.
Whenever a new drawing must align with, match, or be positioned relative to something already on the board, FIRST call get_objects to read exact coordinates, then draw using those numbers. To replicate a shape the user drew, prefer duplicate_object (a pixel-exact copy).
Every draw/move/resize tool result includes the shape's ACTUAL bounding box in percent — compare it against what you intended, and if it's off, correct it immediately with move_object/resize_object using the exact numbers. To put a label inside a box or ellipse, ALWAYS use write_text with boxId — never eyeball text into a shape. To center a rect/ellipse/text on a point, use cx,cy (center placement), not x,y (top-left). cx,cy and boxId already do the centering — pass the target point or box directly, and NEVER pre-offset it by half the text/shape size.
When you place something by EYE relative to what the user drew, verify it on the next video frame: if it is visibly off target, nudge it with move_object. A quick place → look → nudge loop beats trying to aim perfectly on the first try.
IMPORTANT: whenever the coordinates you pass to a drawing tool come from READING the video frame, also pass fromVideo=true — the app then corrects them with your stored calibration automatically. NEVER set fromVideo when the coordinates come from get_objects or a tool result (those are exact), and never do correction arithmetic yourself.
CALIBRATION: when the user asks you to calibrate (e.g. "calibrate", "self-calibrate", "tune your aim"), YOU run the whole test yourself with tool calls — the user does NOTHING, never ask them to draw or to confirm, never wait for a go-ahead. The loop: (1) call calibrate_start — EVERY round starts with this call; it takes a few seconds and returns only once the targets are visible in your video feed; the targets are at RANDOM positions each round, so always read them off the CURRENT video frame, never reuse positions from an earlier round or report, and if you cannot actually SEE red crosses in the frame, wait for the next frame rather than guessing; (2) draw a small ellipse (width 3, height 3) with cx,cy on each red cross and fromVideo=true, and write the word CAL with cx,cy on the CENTER of the dashed blue rectangle, fromVideo=true, sized ~70% of the box height (do NOT use boxId here — this measures your vision); (3) call calibrate_check right away — it refuses to run twice on the same targets, so a new round always means a new calibrate_start. If the user asks to reset or forget the calibration, call calibrate_reset. On the grid, strong NUMBERED lines are the 10s (labels on all four edges) and thin faint lines are the 5s (15, 25, 35...); a target often sits ON a 5-line or between lines, so read every coordinate to the nearest 1 — never snap to the nearest numbered line. Pass the target point/center directly as cx,cy — never pre-offset it by half the size. calibrate_check stores the measured correction (composing it automatically with any correction already applied via fromVideo) and flags "slips" (marks that snapped to a wrong gridline). If its advice says to retry, repeat from step 1 (at most 3 rounds). A SYSTEM NOTE at the start of a session may mention a stored calibration — it simply means fromVideo=true placements are corrected automatically. If the user wants to SEE or screenshot the result, pass keep=true to calibrate_check so the marks stay on the board. Finish by telling the user the mean error in one short sentence — the full report is already in the output panel.
CAD MODE (parametric sketching): the board also has a CAD sketch layer. When the user asks for parametric/CAD/constrained geometry ("sketch a 200 by 100 rectangle", "make these parallel", "set the width to w/2"), or for anything with real dimensions like a floor plan, use the cad_* tools, NOT the plain draw_* tools (plain shapes are dumb ink; CAD shapes re-solve to satisfy constraints). Teal lines with small round markers on the board ARE the CAD sketch; purple labels are its dimensions.
CAD workflow: create geometry with cad_sketch_rect / cad_sketch_line / cad_sketch_polyline / cad_sketch_circle (positions in board percent; a rectangle comes pre-constrained H/V; endpoints drawn near existing sketch points snap and merge). The tool result returns the new ids — REMEMBER them. Then cad_constrain (horizontal, vertical, parallel, perpendicular, equal, coincident, fix) and cad_dimension to lock sizes. Dimension values and parameters are in SKETCH UNITS (the numbers on the purple labels), not percent — cad_get_sketch returns unitsPerPercent when you need to convert a percent size into units. Parameters make sketches parametric: cad_set_param name w value 200, then cad_dimension value "w" or "w/2"; changing the parameter later re-solves the whole sketch. For geometry you did not just create, call cad_get_sketch first to read current ids and positions. Every cad_* result reports solve.ok and degreesOfFreedom: solve.ok=false means the constraints CONFLICT — tell the user and cad_delete the offending constraint (cad_get_sketch lists them); degreesOfFreedom 0 means fully constrained. Do not redraw CAD geometry to change it — add or edit a dimension or parameter and let the solver move it. The solver only enforces what you constrain: geometry you want held in place needs a constraint, not a careful initial position.

SPEAKING. Keep spoken answers short — a sentence or two; the board carries the detail. When the drawing is ambiguous (a digit you cannot read, a shape you cannot identify), ask one brief question instead of guessing.
The very first message you receive will be the single word "BEGIN". When you see it, greet the user in one short sentence and invite them to draw or ask — and do not mention the word BEGIN.`;

// Appended only when the coding agent is available. Debug mode is a different
// job from drawing, so it gets its own short brief rather than more bullets in
// the drawing instructions.
const DEBUG_INSTRUCTION = `

DEBUG MODE — FIXING THE APP ITSELF
Some problems are not about the drawing, they are about this app being broken: a button that does nothing, a shape that lands in the wrong place, an error message, a feature the user wants that does not exist. You can hand those to a backend coding agent that works on the app's own source code, on the machine serving this page. It creates a git branch, edits the code, runs the tests and the build, and pushes — the running site reloads the change by itself, so a fix can land while the user is still standing at the board.

WHEN TO HAND OVER. The user says something is broken, wrong, missing or annoying about the APP — not about their drawing. If you are unsure which they mean, ask one short question ("do you mean the app is misbehaving, or shall I change your drawing?").

THE HAND-OVER IS THE SKILL. Everything the agent knows about the problem is what you write in start_debug_session, so write it properly. Before calling it, make sure you can answer three things — what the user did, what happened, and what should have happened. Ask ONE short question if a critical one is missing; do not interrogate. Then call start_debug_session with:
- title: a short name for the fault (it becomes the branch name)
- summary: what is wrong, in your own words
- stepsToReproduce: what the user did, in order
- expected and actual: the two halves of the bug
- area: which part of the app ('voice', 'cad', 'canvas', 'shapes', 'graph', 'math', 'boards', 'ui', 'server')
- userQuote: the user's own words, verbatim
- wanted: what they asked for, if they asked for a change rather than reporting a fault
A screenshot of the board and the errors the browser captured are attached automatically — you do not need to describe the board, but DO describe anything you saw happen that a screenshot would not show. If you watched the failure yourself, say so, in the summary, as an observation.

WHILE THE SESSION IS OPEN. You are now the voice of the coding agent. Do not draw, do not fix things on the board, do not speculate about the code. Everything the user says about the problem, the fix, or what to do next goes to the agent with debug_message, restated faithfully and in full — including corrections, extra detail, and answers to questions the agent asked. The agent's own words come back to you as spoken updates; read them out as they are, briefly, without embellishing or inventing progress. Use debug_status if the user asks how it is going. If the user asks for something unrelated to the bug, tell them you will pick it up after the session and offer to close it.
The agent's fix reaches the page through a rebuild, so when an update says a reload is needed, tell the user to reload the page.
When the user is done, call end_debug_session, then go back to being the whiteboard assistant.`;

function liveConfig(includeDebug) {
    const tools = buildTools(includeDebug);
    return {
        systemInstruction: SYSTEM_INSTRUCTION + (includeDebug ? DEBUG_INSTRUCTION : ''),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(tools ? { tools } : {}),
    };
}

function attachVoiceServer(server) {
    if (!WebSocketServer) return; // ws unavailable

    const wss = new WebSocketServer({ server, path: '/voice' });
    wss.on('error', () => {}); // EADDRINUSE etc. handled by the http server

    wss.on('connection', async (browserWs, req) => {
        const send = (obj) => {
            if (browserWs.readyState === 1) browserWs.send(JSON.stringify(obj));
        };

        // The browser marks a reconnect (the coding agent's own push restarts the
        // server) and names any debug session it was already in, so the fresh
        // Live session picks the conversation up instead of greeting again.
        const params = new URLSearchParams((req && req.url || '').split('?')[1] || '');
        const isResume = params.get('resume') === '1';
        const resumeDebugId = params.get('debug') || null;

        const apiKey = process.env.GEMINI_API_KEY;
        if (!GoogleGenAI || !apiKey) {
            send({ type: 'error', message: 'Gemini Live is not configured on the server.' });
            browserWs.close();
            return;
        }

        const ai = new GoogleGenAI({ apiKey });
        let committed = false; // only forward model output once we've picked a working session

        // ---- debug mode ------------------------------------------------------
        // Canvas tools run in the browser; debug tools run HERE, because the git
        // repository is on the server. The only thing the browser contributes is
        // the capture (board screenshot + console errors) that goes into the
        // bug report.
        const debugOn = debugAvailable();
        let debugSession = null;
        let debugUnsubscribe = null;
        let lastFrame = null; // newest board JPEG, the fallback screenshot
        const captureWaiters = new Map();

        // Speak to the model out-of-band. Same channel the BEGIN greeting uses:
        // text the user never said, which the model treats as context.
        const noteToModel = (text) => {
            try { if (session) session.sendRealtimeInput({ text }); } catch (e) { /* session gone */ }
        };

        // Ask the browser for a fresh screenshot + captured console errors. Falls
        // back to the last streamed video frame if the page does not answer.
        const requestCapture = (timeoutMs = 5000) => new Promise((resolve) => {
            const id = 'cap_' + Math.random().toString(36).slice(2, 9);
            const finish = (value) => {
                if (!captureWaiters.has(id)) return;
                captureWaiters.delete(id);
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(
                () => finish({ screenshot: lastFrame ? `data:image/jpeg;base64,${lastFrame}` : null, context: null }),
                timeoutMs
            );
            captureWaiters.set(id, finish);
            send({ type: 'debug_capture_request', id });
        });

        // Stream the coding agent's activity to the panel, and turn the parts the
        // user should HEAR into notes for the model to speak.
        const attachDebugEvents = (sess) => {
            if (debugUnsubscribe) { debugUnsubscribe(); debugUnsubscribe = null; }
            debugSession = sess;
            send({ type: 'debug_state', state: debugSessions.publicState(sess) });
            debugUnsubscribe = debugSessions.subscribe(sess.id, (event) => {
                send({ type: 'debug_event', sessionId: sess.id, event });
                if (event.kind === 'say') {
                    noteToModel(
                        'SYSTEM NOTE (the coding agent working on the fix, not the user): pass this on to the user ' +
                        `now, briefly and without adding anything: "${event.message}"`
                    );
                } else if (event.kind === 'done') {
                    noteToModel(
                        'SYSTEM NOTE (the coding agent working on the fix, not the user): it has finished this round. ' +
                        `Tell the user in one or two sentences: "${event.summary || 'Done.'}"` +
                        (event.pushed ? ' The change is committed and pushed, so the site is picking it up.' : '') +
                        (event.needsReload ? ' Tell them to reload the page to see it.' : '') +
                        (event.needsUser ? ' It is waiting on an answer from the user — ask them for it.' : '')
                    );
                } else if (event.kind === 'error') {
                    noteToModel(
                        'SYSTEM NOTE (debug mode): the coding agent hit an error: ' + event.message +
                        '. Tell the user plainly and ask whether to try again or close the session.'
                    );
                }
                if (event.kind === 'status' && event.status === 'ended') {
                    if (debugUnsubscribe) { debugUnsubscribe(); debugUnsubscribe = null; }
                    debugSession = null;
                }
                if (event.kind === 'status' || event.kind === 'done' || event.kind === 'tool_result') {
                    send({ type: 'debug_state', state: debugSessions.publicState(sess) });
                }
            });
        };

        // Re-bind this connection to a debug session that is still running (after
        // a reconnect or a page reload) and tell the model it is still in debug
        // mode. Returns false when the id is unknown or the session has ended.
        const resumeDebugSession = (sessionId) => {
            if (!debugOn || !sessionId) return false;
            const sess = debugSessions.get(sessionId);
            if (!sess || sess.status === 'ended') return false;
            attachDebugEvents(sess);
            noteToModel(
                'SYSTEM NOTE (silent context — not the user speaking): a debug session is already open on branch ' +
                `${sess.branch} for "${sess.report.title}". You are in debug mode: keep relaying what the user says ` +
                'with debug_message and do not draw. Do not greet the user again.'
            );
            return true;
        };

        const handleDebugTool = async (name, args) => {
            const params = args && typeof args === 'object' ? args : {};
            if (!debugOn) return { ok: false, message: debugUnavailableReason() };

            if (name === 'start_debug_session') {
                if (debugSession && debugSession.status !== 'ended') {
                    return {
                        ok: false,
                        message: `A debug session is already open on branch ${debugSession.branch}. Use debug_message to tell the agent about this, or end_debug_session first.`,
                    };
                }
                const capture = params.includeScreenshot === false
                    ? { screenshot: null, context: null }
                    : await requestCapture();
                try {
                    const sess = await debugSessions.create({
                        report: params,
                        context: capture.context,
                        screenshot: capture.screenshot,
                    });
                    attachDebugEvents(sess);
                    debugSessions.send(sess, 'The user is standing at the whiteboard waiting. Start investigating.');
                    return {
                        ok: true,
                        sessionId: sess.id,
                        branch: sess.branch,
                        model: require('./debug/agent').MODEL,
                        screenshotAttached: !!capture.screenshot,
                        missingFromReport: sess.warnings,
                        message:
                            `Debug session open on branch ${sess.branch}; the coding agent is reading the report now. ` +
                            'Tell the user it is on it, then relay everything they say with debug_message. Its progress ' +
                            'will reach you as spoken updates — do not call debug_status just to wait.' +
                            (sess.warnings.length ? ` Missing from your report: ${sess.warnings.join(' ')}` : ''),
                    };
                } catch (e) {
                    return { ok: false, message: `Could not start the debug session: ${e.message}` };
                }
            }

            if (!debugSession || debugSession.status === 'ended') {
                return { ok: false, message: 'No debug session is open. Call start_debug_session first.' };
            }

            if (name === 'debug_message') {
                const result = debugSessions.send(debugSession, params.text);
                return {
                    ...result,
                    message: result.ok
                        ? (result.queued
                            ? 'Passed on. The agent is mid-step and will pick it up next; its reply will come to you as a spoken update.'
                            : 'Passed on. The agent is working; its reply will come to you as a spoken update.')
                        : result.message,
                };
            }
            if (name === 'debug_status') {
                const state = debugSessions.publicState(debugSession);
                return {
                    ...state,
                    message: state.status === 'working'
                        ? 'The agent is working right now. Say so and wait for its update rather than calling again.'
                        : 'The agent is idle — it is waiting for you to send it something.',
                };
            }
            if (name === 'end_debug_session') {
                const result = await debugSessions.end(debugSession, { push: params.push !== false });
                if (debugUnsubscribe) { debugUnsubscribe(); debugUnsubscribe = null; }
                debugSession = null;
                return { ...result, message: `Debug session closed. The work is on branch ${result.branch}.` };
            }
            return { ok: false, message: `Unknown debug tool: ${name}` };
        };

        // Forward a Gemini server message to the browser.
        const forward = (msg) => {
            if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
                const calls = msg.toolCall.functionCalls.map((fc) => ({ id: fc.id, name: fc.name, args: fc.args || {} }));
                const browserCalls = calls.filter((c) => !DEBUG_TOOL_NAMES.has(c.name));
                const serverCalls = calls.filter((c) => DEBUG_TOOL_NAMES.has(c.name));
                if (browserCalls.length) send({ type: 'tool_call', calls: browserCalls });
                for (const call of serverCalls) {
                    send({ type: 'debug_tool', name: call.name, args: call.args });
                    handleDebugTool(call.name, call.args)
                        .catch((e) => ({ ok: false, message: (e && e.message) || String(e) }))
                        .then((result) => {
                            try {
                                session.sendToolResponse({
                                    functionResponses: [{ id: call.id, name: call.name, response: result || {} }],
                                });
                            } catch (e) { /* session closed mid-call */ }
                        });
                }
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
                    config: { responseModalities: [Modality.AUDIO], ...liveConfig(debugOn) },
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
        send({ type: 'ready', debugAvailable: debugOn, debugReason: debugOn ? null : debugUnavailableReason() });
        send({ type: 'info', message: 'Connected — model: ' + workingModel });
        const resumedDebug = resumeDebugSession(resumeDebugId);
        if (isResume) {
            // Picking a dropped conversation back up: no greeting, just enough
            // context that the model does not start over.
            noteToModel(
                'SYSTEM NOTE (silent context — not the user speaking): the connection dropped and has just been ' +
                'restored. Carry on from where you were. Do not greet the user, and do not mention the reconnection ' +
                'unless they ask.' +
                (resumedDebug ? '' : ' Say nothing until the user speaks.')
            );
        } else {
            try { session.sendRealtimeInput({ text: 'BEGIN' }); } catch (e) { /* noop */ } // make the model greet first
        }

        browserWs.on('message', (raw) => {
            let m;
            try { m = JSON.parse(raw.toString()); } catch (e) { return; }
            try {
                if (m.type === 'audio') {
                    session.sendRealtimeInput({ audio: { data: m.data, mimeType: 'audio/pcm;rate=16000' } });
                } else if (m.type === 'video') {
                    lastFrame = m.data; // kept as the fallback screenshot for a bug report
                    session.sendRealtimeInput({ video: { data: m.data, mimeType: 'image/jpeg' } });
                } else if (m.type === 'debug_capture') {
                    const waiter = captureWaiters.get(m.id);
                    if (waiter) waiter({ screenshot: m.screenshot || null, context: m.context || null });
                } else if (m.type === 'debug_attach') {
                    // The panel restored a session from before a page reload.
                    if (!resumeDebugSession(m.sessionId)) send({ type: 'debug_state', state: null });
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
            // The debug session itself outlives the socket (it is stored on disk
            // and re-attached by id); only this connection's listener goes.
            if (debugUnsubscribe) { debugUnsubscribe(); debugUnsubscribe = null; }
            for (const finish of captureWaiters.values()) finish({ screenshot: null, context: null });
            captureWaiters.clear();
        });
    });

    console.log('🎤 Voice relay listening on ws path /voice');
}

module.exports = { attachVoiceServer };
