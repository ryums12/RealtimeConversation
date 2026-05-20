import dotenv from "dotenv";
import express from "express";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import WebSocket, { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 기존 ESM URL 기반 경로 방식은 주석 처리합니다.
// dotenv.config({ path: new URL(".env", import.meta.url) });

dotenv.config({ path: join(__dirname, ".env") });

const app = express();
const port = process.env.PORT || 3000;
const server = createServer(app);
const humeProxyServer = new WebSocketServer({ noServer: true });
const HUME_VOICE_IDS = {
  male: process.env.HUME_MALE_VOICE_ID,
  female: process.env.HUME_FEMALE_VOICE_ID,
};
const allowedVoiceGenders = ["male", "female"];

function maskVoiceId(voiceId) {
  if (!voiceId || voiceId.length < 10) return "configured";
  return `${voiceId.slice(0, 8)}...${voiceId.slice(-4)}`;
}

function buildHumeActingInstruction({
  emotion,
  intensity,
  speakingStyle,
} = {}) {
  const normalizedIntensity = Number.isFinite(Number(intensity))
    ? Math.max(0, Math.min(1, Number(intensity)))
    : null;
  const intensityText =
    normalizedIntensity === null
      ? "natural"
      : normalizedIntensity >= 0.75
        ? "high"
        : normalizedIntensity >= 0.4
          ? "moderate"
          : "gentle";
  const style = typeof speakingStyle === "string" && speakingStyle.trim()
    ? speakingStyle.trim()
    : "clear and conversational";
  const mood = typeof emotion === "string" && emotion.trim() ? emotion.trim() : "neutral";

  return `Speak in a ${style} tone with ${intensityText} ${mood} expression.`;
}

function createLipSyncPlaceholder(extra = {}) {
  return {
    lipSync: {
      enabled: false,
      source: "hume_octave",
      mode: "placeholder",
      timestampsAvailable: false,
      wordTimestamps: [],
      phonemeTimestamps: [],
      visemes: [],
      ...extra,
    },
  };
}

function getMissingHumeConfigError(voiceGender) {
  if (!allowedVoiceGenders.includes(voiceGender)) {
    return "Invalid voice gender.";
  }

  if (!process.env.HUME_API_KEY) {
    return "Missing HUME_API_KEY. Please configure it in the .env file.";
  }

  if (!process.env.HUME_TTS_WEBSOCKET_URL) {
    return "Missing HUME_TTS_WEBSOCKET_URL. Please configure it in the .env file.";
  }

  if (!HUME_VOICE_IDS[voiceGender]) {
    return "Missing Hume voice ID. Please configure HUME_MALE_VOICE_ID or HUME_FEMALE_VOICE_ID in the .env file.";
  }

  return "";
}

function buildHumeWebSocketUrl() {
  const url = new URL(process.env.HUME_TTS_WEBSOCKET_URL);
  url.searchParams.set("api_key", process.env.HUME_API_KEY);
  url.searchParams.set("no_binary", "true");
  url.searchParams.set("instant_mode", "true");
  url.searchParams.set("format_type", "mp3");
  url.searchParams.set("strip_headers", "false");

  if (process.env.HUME_TTS_VERSION) {
    url.searchParams.set("version", process.env.HUME_TTS_VERSION);
  }

  if (process.env.HUME_TTS_VERSION === "2") {
    url.searchParams.append("include_timestamp_types", "word");
    url.searchParams.append("include_timestamp_types", "phoneme");
  }

  return url.toString();
}

function sendClientMessage(clientSocket, payload) {
  if (clientSocket.readyState === WebSocket.OPEN) {
    clientSocket.send(JSON.stringify(payload));
  }
}

const sampleAvatarTool = {
  type: "function",
  name: "set_avatar_state",
  description: "Updates the avatar's emotional expression and speaking style.",
  parameters: {
    type: "object",
    properties: {
      emotion: {
        type: "string",
        enum: [
          "neutral",
          "happy",
          "sad",
          "angry",
          "surprised",
          "confused",
          "encouraging",
          "serious",
        ],
      },
      intensity: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      expression: {
        type: "string",
      },
      speakingStyle: {
        type: "string",
      },
    },
    required: ["emotion", "intensity"],
  },
};

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/session", async (req, res) => {
  const { sdp, scenario, enableSampleTool } = req.body;

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: "OPENAI_API_KEY is missing in backend/.env" });
    return;
  }

  if (!sdp || typeof sdp !== "string") {
    res.status(400).json({ error: "Missing WebRTC SDP offer" });
    return;
  }

  // These instructions become the AI's behavior for this realtime session.
  const instructions =
    typeof scenario === "string" && scenario.trim()
      ? scenario.trim()
      : "Have a brief, friendly voice conversation with the user.";

  const sessionConfig = {
    type: "realtime",
    model: "gpt-realtime",
    instructions,
    output_modalities: ["text"],
  };

  if (enableSampleTool) {
    sessionConfig.tools = [sampleAvatarTool];
    sessionConfig.tool_choice = "auto";
  }

  const formData = new FormData();
  formData.set("sdp", sdp);
  formData.set("session", JSON.stringify(sessionConfig));

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const answerSdp = await response.text();

    if (!response.ok) {
      console.error("OpenAI Realtime API error:", answerSdp);
      res.status(response.status).send(answerSdp);
      return;
    }

    res.type("application/sdp").send(answerSdp);
  } catch (error) {
    console.error("Realtime session negotiation failed:", error);
    res.status(500).json({ error: "Failed to create realtime session" });
  }
});

humeProxyServer.on("connection", (clientSocket) => {
  let humeSocket = null;
  let lastVoiceGender = null;

  function closeHumeSocket() {
    if (humeSocket && humeSocket.readyState === WebSocket.OPEN) {
      humeSocket.send(JSON.stringify({ close: true }));
      humeSocket.close();
    }
    humeSocket = null;
  }

  function connectToHume() {
    return new Promise((resolve, reject) => {
      if (humeSocket?.readyState === WebSocket.OPEN) {
        resolve(humeSocket);
        return;
      }

      const url = buildHumeWebSocketUrl();
      const nextSocket = new WebSocket(url);
      humeSocket = nextSocket;

      nextSocket.on("open", () => {
        sendClientMessage(clientSocket, {
          type: "hume.connection.open",
          status: "connected",
        });
        resolve(nextSocket);
      });

      nextSocket.on("message", (rawData, isBinary) => {
        if (isBinary) {
          sendClientMessage(clientSocket, {
            type: "hume.audio",
            audio: Buffer.from(rawData).toString("base64"),
            audioFormat: "mp3",
            lipSync: createLipSyncPlaceholder().lipSync,
          });
          return;
        }

        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          sendClientMessage(clientSocket, {
            type: "hume.metadata",
            raw: rawData.toString(),
          });
          return;
        }

        const lipSync = createLipSyncPlaceholder({
          timestampsAvailable: Boolean(message.word_timestamps?.length || message.phoneme_timestamps?.length),
          wordTimestamps: message.word_timestamps || [],
          phonemeTimestamps: message.phoneme_timestamps || [],
        }).lipSync;

        if (message.type === "audio" && message.audio) {
          sendClientMessage(clientSocket, {
            type: "hume.audio",
            audio: message.audio,
            audioFormat: message.audio_format || "mp3",
            chunkIndex: message.chunk_index,
            isLastChunk: message.is_last_chunk,
            generationId: message.generation_id,
            snippetId: message.snippet_id,
            requestId: message.request_id,
            text: message.text,
            lipSync,
          });
        } else {
          sendClientMessage(clientSocket, {
            type: "hume.metadata",
            metadata: message,
            lipSync,
          });
        }
      });

      nextSocket.on("close", (code, reason) => {
        sendClientMessage(clientSocket, {
          type: "hume.connection.closed",
          code,
          reason: reason.toString(),
        });
      });

      nextSocket.on("error", (error) => {
        const message = error.message || "Hume WebSocket connection failed.";
        sendClientMessage(clientSocket, {
          type: "hume.error",
          error: message,
        });
        reject(error);
      });
    });
  }

  clientSocket.on("message", async (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch (error) {
      sendClientMessage(clientSocket, {
        type: "hume.error",
        error: `Invalid JSON sent to Hume proxy: ${error.message}`,
      });
      return;
    }

    if (message.type === "close") {
      closeHumeSocket();
      return;
    }

    if (message.type !== "speak") {
      sendClientMessage(clientSocket, {
        type: "hume.error",
        error: "Unsupported Hume proxy message type.",
      });
      return;
    }

    const text = typeof message.text === "string" ? message.text.trim() : "";
    const voiceGender = message.voiceGender;
    const missingConfigError = getMissingHumeConfigError(voiceGender);

    if (missingConfigError) {
      sendClientMessage(clientSocket, {
        type: "hume.error",
        error: missingConfigError,
        status: allowedVoiceGenders.includes(voiceGender) ? 500 : 400,
      });
      return;
    }

    if (!text) {
      sendClientMessage(clientSocket, {
        type: "hume.error",
        error: "Missing text for Hume Octave TTS.",
        status: 400,
      });
      return;
    }

    try {
      const socket = await connectToHume();
      const voiceId = HUME_VOICE_IDS[voiceGender];
      const actingInstruction = buildHumeActingInstruction(message);

      if (lastVoiceGender && lastVoiceGender !== voiceGender) {
        socket.send(JSON.stringify({ flush: true }));
      }
      lastVoiceGender = voiceGender;

      socket.send(JSON.stringify({
        text,
        voice: { id: voiceId },
        description: actingInstruction,
      }));
      socket.send(JSON.stringify({ flush: true }));

      sendClientMessage(clientSocket, {
        type: "hume.request.accepted",
        voiceGender,
        maskedVoiceId: maskVoiceId(voiceId),
        text,
        actingInstruction,
        lipSync: createLipSyncPlaceholder().lipSync,
      });
    } catch (error) {
      sendClientMessage(clientSocket, {
        type: "hume.error",
        error: error.message || "Hume WebSocket connection failed.",
      });
    }
  });

  clientSocket.on("close", closeHumeSocket);
  clientSocket.on("error", closeHumeSocket);
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname !== "/api/hume/tts-stream") {
    socket.destroy();
    return;
  }

  humeProxyServer.handleUpgrade(request, socket, head, (ws) => {
    humeProxyServer.emit("connection", ws, request);
  });
});

server.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
