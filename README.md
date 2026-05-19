# Realtime Voice Conversation Prototype

A smallest-possible React + Vite frontend with a Node.js + Express backend for OpenAI Realtime conversations over WebRTC, with Voicebox handling local TTS playback through `/speak`.

The browser never sees `OPENAI_API_KEY` or Voicebox profile IDs. It sends a WebRTC SDP offer and the scenario text to the backend. The backend adds the scenario as Realtime session instructions, negotiates with OpenAI, and proxies finalized assistant text to Voicebox.

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
PORT=3001
VOICEBOX_BASE_URL=http://127.0.0.1:17493
VOICEBOX_MALE_PROFILE_ID=your-male-profile-id
VOICEBOX_FEMALE_PROFILE_ID=your-female-profile-id
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
4. Speak naturally. The AI response text is sent to Voicebox `/speak`, and Voicebox speaks locally.
5. Click `Stop / Reset` to stop mic capture, close WebRTC, and reset the UI.

## Files

- `src/main.jsx` - minimal React UI and browser WebRTC setup.
- `backend/server.js` - Express backend that securely negotiates the Realtime session and proxies Voicebox `/speak`.
- `backend/.env.example` - environment variable template.
- `vite.config.js` - Vite dev server proxy from `/api/session` and `/api/voicebox` to the backend.

## Notes

- This prototype uses the OpenAI Realtime unified WebRTC flow with `gpt-realtime`.
- OpenAI Realtime is used for conversation and text extraction. Final voice output comes from Voicebox `/speak`.
- Use a recent Node.js version with built-in `fetch` and `FormData` support. Node.js 20 or newer is recommended.
- Browser microphone access requires `localhost` or HTTPS.
