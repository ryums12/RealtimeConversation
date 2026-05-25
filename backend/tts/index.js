import WebSocket, { WebSocketServer } from "ws";
import { getActiveTtsProviderName } from "./config.js";
import { createElevenLabsProviderSession } from "./providers/elevenlabs.js";
import { createHumeOctaveProviderSession } from "./providers/humeOctave.js";

const providerFactories = {
  elevenlabs: createElevenLabsProviderSession,
  hume: createHumeOctaveProviderSession,
  hume_octave: createHumeOctaveProviderSession,
};

function sendClientMessage(clientSocket, payload) {
  if (clientSocket.readyState === WebSocket.OPEN) {
    clientSocket.send(JSON.stringify(payload));
  }
}

function createProviderSession(clientSocket) {
  const providerName = getActiveTtsProviderName();
  const createSession = providerFactories[providerName];

  if (!createSession) {
    return {
      provider: providerName,
      label: providerName,
      speak() {
        sendClientMessage(clientSocket, {
          type: "tts.error",
          provider: providerName,
          error: `Unsupported TTS_PROVIDER "${providerName}". Use "elevenlabs" or "hume_octave".`,
          status: 500,
        });
      },
      close() {},
    };
  }

  const session = createSession({
    sendClientMessage: (payload) => sendClientMessage(clientSocket, payload),
  });

  sendClientMessage(clientSocket, {
    type: "tts.connection.open",
    provider: session.provider,
    label: session.label,
    status: "connected",
  });

  return session;
}

export function createTtsProxyServer() {
  const ttsProxyServer = new WebSocketServer({ noServer: true });

  ttsProxyServer.on("connection", (clientSocket) => {
    const providerSession = createProviderSession(clientSocket);

    clientSocket.on("message", async (rawData) => {
      let message;
      try {
        message = JSON.parse(rawData.toString());
      } catch (error) {
        sendClientMessage(clientSocket, {
          type: "tts.error",
          provider: providerSession.provider,
          error: `Invalid JSON sent to TTS proxy: ${error.message}`,
        });
        return;
      }

      if (message.type === "close") {
        providerSession.close();
        return;
      }

      if (message.type !== "speak") {
        sendClientMessage(clientSocket, {
          type: "tts.error",
          provider: providerSession.provider,
          error: "Unsupported TTS proxy message type.",
        });
        return;
      }

      await providerSession.speak(message);
    });

    clientSocket.on("close", () => providerSession.close());
    clientSocket.on("error", () => providerSession.close());
  });

  return ttsProxyServer;
}
