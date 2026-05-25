import {
  buildActingInstruction,
  createLipSyncPlaceholder,
  getVoiceGenderError,
  maskVoiceId,
} from "../config.js";

function getElevenLabsVoiceIds() {
  return {
    male: process.env.ELEVENLABS_MALE_VOICE_ID?.trim(),
    female: process.env.ELEVENLABS_FEMALE_VOICE_ID?.trim(),
  };
}

function getElevenLabsStreamUrl(voiceId) {
  const baseUrl = (process.env.ELEVENLABS_TTS_API_URL || "https://api.elevenlabs.io/v1/text-to-speech")
    .trim()
    .replace(/\/$/, "");
  const outputFormat = (process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128").trim();
  const url = new URL(`${baseUrl}/${encodeURIComponent(voiceId)}/stream`);
  url.searchParams.set("output_format", outputFormat);
  url.searchParams.set("optimize_streaming_latency", process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || "3");
  return url.toString();
}

function getMissingElevenLabsConfigError(voiceGender) {
  const voiceGenderError = getVoiceGenderError(voiceGender);
  if (voiceGenderError) return voiceGenderError;

  if (!process.env.ELEVENLABS_API_KEY) {
    return "Missing ELEVENLABS_API_KEY. Please configure it in the .env file.";
  }

  if (!getElevenLabsVoiceIds()[voiceGender]) {
    return "Missing ElevenLabs voice ID. Please configure ELEVENLABS_MALE_VOICE_ID or ELEVENLABS_FEMALE_VOICE_ID in the .env file.";
  }

  return "";
}

function createRequestBody(text) {
  return {
    text,
    model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
    voice_settings: {
      stability: Number(process.env.ELEVENLABS_VOICE_STABILITY || 0.45),
      similarity_boost: Number(process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || 0.8),
      style: Number(process.env.ELEVENLABS_VOICE_STYLE || 0.35),
      use_speaker_boost: process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false",
    },
  };
}

async function streamToBase64(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }

  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("base64");
}

export function createElevenLabsProviderSession({ sendClientMessage }) {
  let requestCounter = 0;
  let closed = false;

  return {
    provider: "elevenlabs",
    label: "ElevenLabs",

    async speak(message) {
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const voiceGender = message.voiceGender;
      const missingConfigError = getMissingElevenLabsConfigError(voiceGender);

      if (missingConfigError) {
        sendClientMessage({
          type: "tts.error",
          provider: "elevenlabs",
          error: missingConfigError,
          status: getVoiceGenderError(voiceGender) ? 400 : 500,
        });
        return;
      }

      if (!text) {
        sendClientMessage({
          type: "tts.error",
          provider: "elevenlabs",
          error: "Missing text for ElevenLabs TTS.",
          status: 400,
        });
        return;
      }

      const requestId = `elevenlabs-${Date.now()}-${requestCounter += 1}`;
      const voiceId = getElevenLabsVoiceIds()[voiceGender];
      const actingInstruction = buildActingInstruction(message);
      const lipSync = createLipSyncPlaceholder("elevenlabs").lipSync;

      sendClientMessage({
        type: "tts.request.accepted",
        provider: "elevenlabs",
        voiceGender,
        maskedVoiceId: maskVoiceId(voiceId),
        text,
        actingInstruction,
        requestId,
        lipSync,
      });

      try {
        const response = await fetch(getElevenLabsStreamUrl(voiceId), {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify(createRequestBody(text)),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`ElevenLabs TTS request failed (${response.status}): ${errorBody || response.statusText}`);
        }

        const audio = await streamToBase64(response);
        if (!closed) {
          sendClientMessage({
            type: "tts.audio",
            provider: "elevenlabs",
            audio,
            audioFormat: "mp3",
            chunkIndex: 1,
            isLastChunk: true,
            requestId,
            text,
            lipSync,
          });
        }

        sendClientMessage({
          type: "tts.metadata",
          provider: "elevenlabs",
          metadata: { requestId, status: "completed" },
          lipSync,
        });
      } catch (error) {
        if (closed) return;
        sendClientMessage({
          type: "tts.error",
          provider: "elevenlabs",
          error: error.message || "ElevenLabs TTS request failed.",
        });
      }
    },

    close() {
      closed = true;
    },
  };
}
