import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 기존 ESM URL 기반 경로 방식은 주석 처리합니다.
// dotenv.config({ path: new URL(".env", import.meta.url) });

dotenv.config({ path: join(__dirname, ".env") });

const app = express();
const port = process.env.PORT || 3000;
const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL;
const VOICEBOX_PROFILE_IDS = {
  male: process.env.VOICEBOX_MALE_PROFILE_ID,
  female: process.env.VOICEBOX_FEMALE_PROFILE_ID,
};
const allowedVoiceGenders = ["male", "female"];

function maskProfileId(profileId) {
  if (!profileId || profileId.length < 12) return "configured";
  return `${profileId.slice(0, 4)}...${profileId.slice(-4)}`;
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

app.post("/api/voicebox/speak", async (req, res) => {
  const { text, voiceGender, language = "ko" } = req.body;

  if (!VOICEBOX_BASE_URL) {
    res.status(500).json({ error: "Missing VOICEBOX_BASE_URL. Please configure it in the .env file." });
    return;
  }

  if (!allowedVoiceGenders.includes(voiceGender)) {
    res.status(400).json({ error: "Invalid voice gender." });
    return;
  }

  const profileId = VOICEBOX_PROFILE_IDS[voiceGender];

  if (!profileId) {
    res.status(500).json({
      error:
        "Missing Voicebox profile ID. Please configure VOICEBOX_MALE_PROFILE_ID or VOICEBOX_FEMALE_PROFILE_ID in the .env file.",
    });
    return;
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "Missing text for Voicebox speak." });
    return;
  }

  try {
    const voiceboxResponse = await fetch(`${VOICEBOX_BASE_URL}/speak`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text.trim(),
        profile: profileId,
        language,
      }),
    });

    const responseBody = await voiceboxResponse.text();

    if (!voiceboxResponse.ok) {
      res.status(voiceboxResponse.status).json({
        error: `Voicebox /speak failed with HTTP ${voiceboxResponse.status}.`,
        status: voiceboxResponse.status,
        body: responseBody,
      });
      return;
    }

    res.json({
      ok: true,
      voiceGender,
      maskedProfileId: maskProfileId(profileId),
      response: responseBody,
    });
  } catch (error) {
    res.status(503).json({
      error:
        `Voicebox server is not reachable. Please check that Voicebox is running at ${VOICEBOX_BASE_URL}.`,
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
