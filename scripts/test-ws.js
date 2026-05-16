// Smoke-test the streaming WS flow without the ESP32.
//
// Usage (from backend/):
//   node scripts/test-ws.js "Hi Liz, how are you?"
//
// Connects to ws://localhost:3000/ws, sends a typed chat message, writes the
// returned PCM to liz-out.wav (24 kHz s16le mono with a WAV header), and
// prints each JSON event to the console.

const fs = require('node:fs');
const WebSocket = require('ws');

const url = process.env.WS_URL || 'ws://localhost:3000/ws';
const message = process.argv[2] || 'Hi Liz, say hello.';
const outPath = process.env.WS_OUT || 'liz-out.wav';

const SAMPLE_RATE = 24000;
const pcmChunks = [];

function buildWavHeader(dataSize, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

console.log(`[test] connecting to ${url}`);
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log(`[test] sending chat: ${JSON.stringify(message)}`);
  ws.send(JSON.stringify({type: 'chat', message, session_id: 'cli-test'}));
});

let bytes = 0;
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    pcmChunks.push(data);
    bytes += data.length;
    process.stdout.write('.');
    return;
  }
  const text = data.toString();
  console.log('\n[event]', text);
  try {
    const evt = JSON.parse(text);
    if (evt.type === 'audio_end' || evt.type === 'error') {
      ws.close();
    }
  } catch {
    // ignore parse errors — let the connection drain
  }
});

ws.on('close', () => {
  if (pcmChunks.length === 0) {
    console.log('[test] no PCM received — check that TTS / Ollama / Chroma are running');
    process.exit(1);
  }
  const pcm = Buffer.concat(pcmChunks);
  const header = buildWavHeader(pcm.length, SAMPLE_RATE);
  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
  console.log(`[test] wrote ${outPath} (${bytes} PCM bytes, ${(bytes / (SAMPLE_RATE * 2)).toFixed(2)}s of audio)`);
  console.log(`[test] play it with: ffplay -autoexit -nodisp -loglevel error ${outPath}`);
});

ws.on('error', (err) => {
  console.error('[test] error:', err.message);
  process.exit(1);
});
