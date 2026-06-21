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
try {
    ({ GoogleGenAI, Modality } = require('@google/genai'));
} catch (e) {
    // @google/genai missing — handled below.
}

// The Live model id differs by API provider. We try a list until one connects;
// override with GEMINI_LIVE_MODEL to pin a specific one.
const CANDIDATE_MODELS = process.env.GEMINI_LIVE_MODEL
    ? [process.env.GEMINI_LIVE_MODEL]
    : [
        'gemini-2.5-flash-native-audio-preview-12-2025',
        'gemini-2.5-flash-preview-native-audio-dialog',
        'gemini-live-2.5-flash-native-audio',
        'gemini-live-2.5-flash-preview',
        'gemini-2.0-flash-live-001',
    ];

const SYSTEM_INSTRUCTION = `You are a friendly, concise voice tutor looking at a shared math whiteboard.
You can see the user's drawing (it streams to you as video) and hear them speak.
Help them with equations and graphs. Keep spoken answers short and conversational.
When the drawing is ambiguous (e.g. a digit you can't read), ask a brief clarifying question.
The very first message you receive will be the single word "BEGIN". When you see it, greet the user in one short sentence and invite them to draw a math problem or ask a question — and do not mention the word BEGIN.`;

const LIVE_CONFIG = {
    systemInstruction: SYSTEM_INSTRUCTION,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
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
            const sc = msg.serverContent;
            if (!sc) return;
            const parts = sc.modelTurn && sc.modelTurn.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.data) send({ type: 'audio', data: part.inlineData.data });
                    if (part.text) send({ type: 'text', role: 'model', data: part.text });
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
                    'Could not start a Gemini Live session (tried ' + CANDIDATE_MODELS.length + ' model(s)). ' +
                    'Last error: ' + (lastErr && lastErr.message) + '. Set GEMINI_LIVE_MODEL to a valid Live model.',
            });
            browserWs.close();
            return;
        }

        committed = true;
        console.log('🎤 Voice session connected (model: ' + workingModel + ')');
        send({ type: 'ready' });
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
