# Realtime Voice Conversation Prototype

A smallest-possible React + Vite frontend with a Node.js + Express backend for OpenAI Realtime voice conversations over WebRTC.

The browser never sees `OPENAI_API_KEY`. It sends a WebRTC SDP offer and the scenario text to the backend. The backend adds the scenario as Realtime session instructions and negotiates with OpenAI.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create the backend environment file:

```bash
cp backend/.env.example backend/.env
```

3. Put your OpenAI API key in `backend/.env`:

```bash
OPENAI_API_KEY=sk-your-real-key
PORT=3000
```

## Run

Start the backend and frontend together:

```bash
npm run dev
```

Open the Vite URL shown in the terminal, usually:

```text
http://localhost:5173
```

## How To Use

1. Type the voice conversation scenario in the textarea.
2. Click `Start Conversation`.
3. Allow microphone access.
4. Speak naturally. The AI's audio response plays through the browser.
5. Click `Stop / Reset` to stop mic capture, close WebRTC, and reset the UI.

## Files

- `src/main.jsx` - minimal React UI and browser WebRTC setup.
- `backend/server.js` - Express backend that securely negotiates the Realtime session.
- `backend/.env.example` - environment variable template.
- `vite.config.js` - Vite dev server proxy from `/session` to the backend.

## Notes

- This prototype uses the OpenAI Realtime unified WebRTC flow with `gpt-realtime`.
- Use a recent Node.js version with built-in `fetch` and `FormData` support. Node.js 20 or newer is recommended.
- Browser microphone access requires `localhost` or HTTPS.
