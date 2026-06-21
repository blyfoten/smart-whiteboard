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

const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio';

const SYSTEM_INSTRUCTION = `You are a friendly, concise voice tutor looking at a shared math whiteboard.
You can see the user's drawing (it streams to you as video) and hear them speak.
Help them with equations and graphs. Keep spoken answers short and conversational.
When the drawing is ambiguous (e.g. a digit you can't read), ask a brief clarifying question.`;

function attachVoiceServer(server) {
    if (!WebSocketServer) return; // ws unavailable

    const wss = new WebSocketServer({ server, path: '/voice' });
    wss.on('error', () => {}); // server's EADDRINUSE is handled by the http server's error handler

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
        let session = null;

        try {
            session = await ai.live.connect({
                model: LIVE_MODEL,
                config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: SYSTEM_INSTRUCTION,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
                callbacks: {
                    onopen: () => send({ type: 'ready' }),
                    onmessage: (msg) => {
                        if (msg.setupComplete) send({ type: 'ready' });
                        const sc = msg.serverContent;
                        if (!sc) return;
                        const parts = sc.modelTurn && sc.modelTurn.parts;
                        if (Array.isArray(parts)) {
                            for (const part of parts) {
                                if (part.inlineData && part.inlineData.data) {
                                    send({ type: 'audio', data: part.inlineData.data });
                                }
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
                    },
                    onerror: (e) => send({ type: 'error', message: (e && e.message) || String(e) }),
                    onclose: (e) => send({ type: 'closed', message: (e && e.reason) || '' }),
                },
            });
        } catch (e) {
            send({ type: 'error', message: 'Failed to connect to Gemini Live: ' + (e.message || e) });
            browserWs.close();
            return;
        }

        browserWs.on('message', (raw) => {
            if (!session) return;
            let m;
            try {
                m = JSON.parse(raw.toString());
            } catch (e) {
                return;
            }
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

    console.log('🎤 Voice relay listening on ws path /voice (model: ' + LIVE_MODEL + ')');
}

module.exports = { attachVoiceServer };
