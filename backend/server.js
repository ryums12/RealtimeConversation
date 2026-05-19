import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Readable } from "stream";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 기존 ESM URL 기반 경로 방식은 주석 처리합니다.
// dotenv.config({ path: new URL(".env", import.meta.url) });

dotenv.config({ path: join(__dirname, ".env") });

const app = express();
const port = process.env.PORT || 3000;
const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL || "http://127.0.0.1:17493";
const VOICEBOX_PROFILE_IDS = {
  male: "b482df36-2aef-4fac-8995-f497fd60f5f7",
  female: "19d52563-b6ba-4f27-aa32-f19d7d8bc1ac",
};

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

app.post("/api/voicebox/generate", async (req, res) => {
  const { text, voiceGender, language = "ko" } = req.body;
  const profileId = VOICEBOX_PROFILE_IDS[voiceGender];

  if (!profileId) {
    res.status(400).json({ error: "Invalid voiceGender. Expected male or female." });
    return;
  }

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing text for Voicebox generation." });
    return;
  }

  try {
    const voiceboxResponse = await fetch(`${VOICEBOX_BASE_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        profile_id: profileId,
        text,
        language,
      }),
    });

    const responseBody = await voiceboxResponse.text();

    if (!voiceboxResponse.ok) {
      res.status(voiceboxResponse.status).json({
        error: "Voicebox generation failed.",
        status: voiceboxResponse.status,
        body: responseBody,
      });
      return;
    }

    let parsedBody = {};
    try {
      parsedBody = responseBody ? JSON.parse(responseBody) : {};
    } catch {
      parsedBody = { raw: responseBody };
    }

    const generationId =
      parsedBody.generationId ||
      parsedBody.generation_id ||
      parsedBody.id ||
      parsedBody.audio_id;

    if (!generationId) {
      res.status(502).json({
        error: "Voicebox generation response did not include a generation ID.",
        body: parsedBody,
      });
      return;
    }

    res.json({
      generationId,
      voiceGender,
      profileId,
      response: parsedBody,
    });
  } catch (error) {
    res.status(503).json({
      error:
        "Voicebox server is not reachable. Please check that Voicebox is running at http://127.0.0.1:17493.",
      details: error.message,
    });
  }
});

app.get("/api/voicebox/audio/:id", async (req, res) => {
  try {
    const audioResponse = await fetch(
      `${VOICEBOX_BASE_URL}/audio/${encodeURIComponent(req.params.id)}`
    );

    if (!audioResponse.ok) {
      const errorBody = await audioResponse.text();
      res.status(audioResponse.status).json({
        error: "Voicebox audio fetch failed.",
        status: audioResponse.status,
        body: errorBody,
      });
      return;
    }

    res.status(audioResponse.status);
    res.setHeader("Content-Type", audioResponse.headers.get("content-type") || "audio/mpeg");
    const contentLength = audioResponse.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    Readable.fromWeb(audioResponse.body).pipe(res);
  } catch (error) {
    res.status(503).json({
      error:
        "Voicebox server is not reachable. Please check that Voicebox is running at http://127.0.0.1:17493.",
      details: error.message,
    });
  }
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

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
