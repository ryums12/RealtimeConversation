export const allowedVoiceGenders = ["male", "female"];

export function getActiveTtsProviderName() {
  return (process.env.TTS_PROVIDER || "elevenlabs").trim().toLowerCase();
}

export function getVoiceGenderError(voiceGender) {
  return allowedVoiceGenders.includes(voiceGender) ? "" : "Invalid voice gender.";
}

export function maskVoiceId(voiceId) {
  if (!voiceId || voiceId.length < 10) return "configured";
  return `${voiceId.slice(0, 8)}...${voiceId.slice(-4)}`;
}

export function buildActingInstruction({
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

export function createLipSyncPlaceholder(source, extra = {}) {
  return {
    lipSync: {
      enabled: false,
      source,
      mode: "placeholder",
      timestampsAvailable: false,
      wordTimestamps: [],
      phonemeTimestamps: [],
      visemes: [],
      ...extra,
    },
  };
}
