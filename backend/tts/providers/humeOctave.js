import WebSocket from "ws";
import {
  buildActingInstruction,
  createLipSyncPlaceholder,
  getVoiceGenderError,
  maskVoiceId,
} from "../config.js";

function getHumeVoiceIds() {
  return {
    male: process.env.HUME_MALE_VOICE_ID,
    female: process.env.HUME_FEMALE_VOICE_ID,
  };
}

function getMissingHumeConfigError(voiceGender) {
  const voiceGenderError = getVoiceGenderError(voiceGender);
  if (voiceGenderError) return voiceGenderError;

  if (!process.env.HUME_API_KEY) {
    return "Missing HUME_API_KEY. Please configure it in the .env file.";
  }

  if (!process.env.HUME_TTS_WEBSOCKET_URL) {
    return "Missing HUME_TTS_WEBSOCKET_URL. Please configure it in the .env file.";
  }

  if (!getHumeVoiceIds()[voiceGender]) {
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

export function createHumeOctaveProviderSession({ sendClientMessage }) {
  let humeSocket = null;
  let lastVoiceGender = null;

  function close() {
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

      const nextSocket = new WebSocket(buildHumeWebSocketUrl());
      humeSocket = nextSocket;

      nextSocket.on("open", () => {
        sendClientMessage({
          type: "tts.connection.open",
          provider: "hume_octave",
          status: "connected",
        });
        resolve(nextSocket);
      });

      nextSocket.on("message", (rawData, isBinary) => {
        if (isBinary) {
          sendClientMessage({
            type: "tts.audio",
            provider: "hume_octave",
            audio: Buffer.from(rawData).toString("base64"),
            audioFormat: "mp3",
            lipSync: createLipSyncPlaceholder("hume_octave").lipSync,
          });
          return;
        }

        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          sendClientMessage({
            type: "tts.metadata",
            provider: "hume_octave",
            raw: rawData.toString(),
          });
          return;
        }

        const lipSync = createLipSyncPlaceholder("hume_octave", {
          timestampsAvailable: Boolean(message.word_timestamps?.length || message.phoneme_timestamps?.length),
          wordTimestamps: message.word_timestamps || [],
          phonemeTimestamps: message.phoneme_timestamps || [],
        }).lipSync;

        if (message.type === "audio" && message.audio) {
          sendClientMessage({
            type: "tts.audio",
            provider: "hume_octave",
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
          sendClientMessage({
            type: "tts.metadata",
            provider: "hume_octave",
            metadata: message,
            lipSync,
          });
        }
      });

      nextSocket.on("close", (code, reason) => {
        sendClientMessage({
          type: "tts.connection.closed",
          provider: "hume_octave",
          code,
          reason: reason.toString(),
        });
      });

      nextSocket.on("error", (error) => {
        sendClientMessage({
          type: "tts.error",
          provider: "hume_octave",
          error: error.message || "Hume WebSocket connection failed.",
        });
        reject(error);
      });
    });
  }

  return {
    provider: "hume_octave",
    label: "Hume Octave",

    async speak(message) {
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const voiceGender = message.voiceGender;
      const missingConfigError = getMissingHumeConfigError(voiceGender);

      if (missingConfigError) {
        sendClientMessage({
          type: "tts.error",
          provider: "hume_octave",
          error: missingConfigError,
          status: getVoiceGenderError(voiceGender) ? 400 : 500,
        });
        return;
      }

      if (!text) {
        sendClientMessage({
          type: "tts.error",
          provider: "hume_octave",
          error: "Missing text for Hume Octave TTS.",
          status: 400,
        });
        return;
      }

      try {
        const socket = await connectToHume();
        const voiceId = getHumeVoiceIds()[voiceGender];
        const actingInstruction = buildActingInstruction(message);

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

        sendClientMessage({
          type: "tts.request.accepted",
          provider: "hume_octave",
          voiceGender,
          maskedVoiceId: maskVoiceId(voiceId),
          text,
          actingInstruction,
          lipSync: createLipSyncPlaceholder("hume_octave").lipSync,
        });
      } catch (error) {
        sendClientMessage({
          type: "tts.error",
          provider: "hume_octave",
          error: error.message || "Hume WebSocket connection failed.",
        });
      }
    },

    close,
  };
}
