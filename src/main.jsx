import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const MAX_EVENT_LOG_ITEMS = 150;
const MAX_SPEECH_HISTORY_ITEMS = 6;
const VOICE_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
];
const HUME_LIP_SYNC_PLACEHOLDER = {
  enabled: false,
  source: "hume_octave",
  mode: "placeholder",
  timestampsAvailable: false,
  wordTimestamps: [],
  phonemeTimestamps: [],
  visemes: [],
};

function safeJsonParse(rawString) {
  if (!rawString) {
    return { parsed: null, error: "No arguments received yet" };
  }

  try {
    return { parsed: JSON.parse(rawString), error: null };
  } catch (error) {
    return { parsed: null, error: error.message };
  }
}

function getJsonParseStatus(toolCall) {
  if (!toolCall.rawArguments || (toolCall.status === "streaming" && toolCall.jsonParseError)) {
    return "pending";
  }

  return toolCall.jsonParseError ? "invalid JSON" : "valid JSON";
}

function getTimestamp() {
  return new Date().toISOString();
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

function getHumeSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/hume/tts-stream`;
}

function extractCompleteSentenceChunks(buffer) {
  const chunks = [];
  let startIndex = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === "." || char === "?" || char === "!" || char === "\n") {
      const chunk = buffer.slice(startIndex, index + 1).trim();
      if (chunk) chunks.push(chunk);
      startIndex = index + 1;
    }
  }

  return {
    chunks,
    remaining: buffer.slice(startIndex),
  };
}

function splitSpeechIntoChunks(text) {
  const { chunks, remaining } = extractCompleteSentenceChunks(text || "");
  const tail = remaining.trim();
  return tail ? [...chunks, tail] : chunks;
}

function base64ToBlobUrl(base64Audio, audioFormat = "mp3") {
  const binary = window.atob(base64Audio);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const mimeType = audioFormat === "wav" ? "audio/wav" : "audio/mpeg";
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function compactEventPreview(event) {
  return {
    type: event.type,
    response_id: event.response_id,
    item_id: event.item_id,
    call_id: event.call_id,
    output_index: event.output_index,
    content_index: event.content_index,
    delta: event.delta,
    transcript: event.transcript,
    text: event.text,
    arguments: event.arguments,
    error: event.error,
    item: event.item,
  };
}

function isRelevantRealtimeEvent(event) {
  if (!event?.type) return false;

  return (
    event.type === "error" ||
    event.type.startsWith("response.") ||
    event.type.includes("transcript") ||
    event.type.includes("text") ||
    event.type.includes("function_call") ||
    event.type.includes("tool")
  );
}

function getToolCallKey(event) {
  return (
    event.call_id ||
    event.item_id ||
    event.output_item_id ||
    [event.response_id, event.output_index, event.content_index].filter(Boolean).join(":") ||
    `tool-call-${Date.now()}`
  );
}

function extractFunctionName(event) {
  return event.name || event.function?.name || event.item?.name || event.item?.function?.name || "unknown";
}

function extractArgumentsDelta(event) {
  return event.delta ?? event.arguments_delta ?? event.item?.arguments_delta ?? "";
}

function extractCompletedArguments(event) {
  return event.arguments ?? event.item?.arguments ?? event.function?.arguments ?? null;
}

function getAssistantSpeechDelta(event) {
  if (
    event.type === "response.audio_transcript.delta" ||
    event.type === "response.output_text.delta" ||
    event.type === "response.text.delta"
  ) {
    return event.delta || "";
  }

  return "";
}

function getAssistantSpeechFinal(event) {
  if (
    event.type === "response.audio_transcript.done" ||
    event.type === "response.output_text.done" ||
    event.type === "response.text.done"
  ) {
    return event.transcript || event.text || "";
  }

  if (event.type === "response.content_part.done") {
    return event.part?.transcript || event.part?.text || "";
  }

  return "";
}

function CopyButton({ value, label = "Copy", disabled = false }) {
  async function copyValue() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
  }

  return (
    <button className="secondary-button compact-button" onClick={copyValue} disabled={disabled || !value}>
      {label}
    </button>
  );
}

function App() {
  const [scenario, setScenario] = useState(
    "You are a friendly English conversation partner. Keep replies short and ask one question at a time."
  );
  const [enableSampleTool, setEnableSampleTool] = useState(false);
  const [voiceGender, setVoiceGender] = useState("male");
  const [enableResponseLogs, setEnableResponseLogs] = useState(true);
  const [showLogPanel, setShowLogPanel] = useState(true);
  const [status, setStatus] = useState("Idle");
  const [humeStatus, setHumeStatus] = useState("Hume Octave idle");
  const [humeError, setHumeError] = useState("");
  const [humeDebug, setHumeDebug] = useState({
    selectedVoiceGender: "male",
    maskedVoiceId: "Not resolved yet",
    connectionStatus: "disconnected",
    streamingStatus: "idle",
    latestTextChunk: "",
    latestActingInstruction: "",
    latestError: "",
    playbackStatus: "idle",
    hasLipSyncPlaceholder: true,
  });
  const [lipSyncPlaceholder, setLipSyncPlaceholder] = useState(HUME_LIP_SYNC_PLACEHOLDER);
  const [isRunning, setIsRunning] = useState(false);
  const [currentSpeechText, setCurrentSpeechText] = useState("");
  const [finalSpeechText, setFinalSpeechText] = useState("");
  const [speechHistory, setSpeechHistory] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [eventLog, setEventLog] = useState([]);

  const peerConnectionRef = useRef(null);
  const eventChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const humeSocketRef = useRef(null);
  const humeMessageQueueRef = useRef([]);
  const humeRunIdRef = useRef(0);
  const humeAudioQueueRef = useRef([]);
  const humeAudioPlayingRef = useRef(false);
  const humeCurrentAudioRef = useRef(null);
  const voiceGenderRef = useRef(voiceGender);
  const enableResponseLogsRef = useRef(enableResponseLogs);
  const currentSpeechBufferRef = useRef("");
  const sentenceSpeechBufferRef = useRef("");
  const sentSentenceChunksRef = useRef(new Set());
  const lastFinalSpeechRef = useRef("");
  const latestAvatarStateRef = useRef({});

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
    setHumeDebug((debug) => ({
      ...debug,
      selectedVoiceGender: voiceGender,
    }));
    appendLog("hume.voice.selected", { voiceGender });
  }, [voiceGender]);

  useEffect(() => {
    enableResponseLogsRef.current = enableResponseLogs;
  }, [enableResponseLogs]);

  function appendLog(type, preview) {
    if (!enableResponseLogsRef.current) return;

    const logItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: type || "unknown",
      timestamp: getTimestamp(),
      preview,
    };

    setEventLog((items) => [logItem, ...items].slice(0, MAX_EVENT_LOG_ITEMS));
  }

  function appendRealtimeEvent(event) {
    if (!isRelevantRealtimeEvent(event)) return;
    appendLog(event.type, compactEventPreview(event));
  }

  function updateSpeechText(deltaOrText) {
    if (!deltaOrText) return;

    currentSpeechBufferRef.current += deltaOrText;
    setCurrentSpeechText(currentSpeechBufferRef.current);
    appendLog("openai.realtime.text_delta", { text: deltaOrText });

    sentenceSpeechBufferRef.current += deltaOrText;
    const { chunks, remaining } = extractCompleteSentenceChunks(sentenceSpeechBufferRef.current);
    sentenceSpeechBufferRef.current = remaining;

    chunks.forEach((chunk) => enqueueHumeSpeech(chunk, "sentence_delta"));
  }

  function finalizeSpeechText(text) {
    const completedText = text || currentSpeechBufferRef.current;
    if (!completedText || completedText === lastFinalSpeechRef.current) return;

    currentSpeechBufferRef.current = "";
    lastFinalSpeechRef.current = completedText;
    setCurrentSpeechText("");
    setFinalSpeechText(completedText);
    appendLog("assistant.speech.final", { text: completedText });

    const finalChunks = sentSentenceChunksRef.current.size > 0
      ? [sentenceSpeechBufferRef.current.trim()].filter(Boolean)
      : splitSpeechIntoChunks(completedText);
    sentenceSpeechBufferRef.current = "";
    finalChunks.forEach((chunk) => enqueueHumeSpeech(chunk, "final_text"));

    setSpeechHistory((items) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          text: completedText,
          timestamp: getTimestamp(),
        },
        ...items,
      ].slice(0, MAX_SPEECH_HISTORY_ITEMS)
    );
  }

  function updateHumeDebug(patch) {
    setHumeDebug((debug) => ({
      ...debug,
      ...patch,
      hasLipSyncPlaceholder: true,
    }));
  }

  function clearHumePlayback() {
    humeRunIdRef.current += 1;
    humeMessageQueueRef.current = [];
    humeAudioQueueRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    humeAudioQueueRef.current = [];
    humeAudioPlayingRef.current = false;
    humeCurrentAudioRef.current?.pause();
    humeCurrentAudioRef.current = null;

    if (humeSocketRef.current?.readyState === WebSocket.OPEN) {
      humeSocketRef.current.send(JSON.stringify({ type: "close" }));
      humeSocketRef.current.close();
    }
    humeSocketRef.current = null;

    setHumeStatus("Hume Octave idle");
    updateHumeDebug({
      connectionStatus: "disconnected",
      streamingStatus: "idle",
      playbackStatus: "idle",
    });
  }

  function enqueueHumeSpeech(text, source) {
    const trimmedText = text?.trim();
    if (!trimmedText) return;
    if (sentSentenceChunksRef.current.has(trimmedText)) return;
    sentSentenceChunksRef.current.add(trimmedText);

    const emotionState = latestAvatarStateRef.current || {};
    const actingInstruction = buildHumeActingInstruction(emotionState);
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: trimmedText,
      voiceGender: voiceGenderRef.current,
      emotion: emotionState.emotion,
      intensity: emotionState.intensity,
      speakingStyle: emotionState.speakingStyle,
      actingInstruction,
      source,
      lipSync: {
        enabled: false,
        mode: "placeholder",
      },
    };

    humeMessageQueueRef.current.push(item);
    appendLog("hume.sentence_chunk.queued", {
      voiceGender: item.voiceGender,
      source,
      text: item.text,
      actingInstruction,
    });
    sendQueuedHumeMessages();
  }

  function connectHumeSocket() {
    const existingSocket = humeSocketRef.current;
    if (existingSocket?.readyState === WebSocket.OPEN) return existingSocket;
    if (existingSocket?.readyState === WebSocket.CONNECTING) return existingSocket;

    setHumeError("");
    setHumeStatus("Connecting to Hume Octave...");
    updateHumeDebug({
      connectionStatus: "connecting",
      streamingStatus: "connecting",
      latestError: "",
    });

    const socket = new WebSocket(getHumeSocketUrl());
    humeSocketRef.current = socket;

    socket.onopen = () => {
      setHumeStatus("Hume Octave connected");
      updateHumeDebug({
        connectionStatus: "connected",
        streamingStatus: "ready",
      });
      appendLog("hume.websocket.open", { endpoint: "/api/hume/tts-stream" });
      sendQueuedHumeMessages();
    };

    socket.onclose = (event) => {
      setHumeStatus("Hume Octave disconnected");
      updateHumeDebug({
        connectionStatus: "disconnected",
        streamingStatus: "idle",
      });
      appendLog("hume.websocket.closed", { code: event.code, reason: event.reason });
    };

    socket.onerror = () => {
      const message = "Hume Octave proxy WebSocket failed.";
      setHumeError(message);
      setHumeStatus("Hume Octave error");
      updateHumeDebug({
        connectionStatus: "error",
        streamingStatus: "error",
        latestError: message,
      });
      appendLog("hume.error", { message });
    };

    socket.onmessage = (messageEvent) => {
      try {
        handleHumeMessage(JSON.parse(messageEvent.data));
      } catch (error) {
        const message = error.message || "Could not parse Hume proxy message.";
        setHumeError(message);
        updateHumeDebug({ latestError: message });
        appendLog("hume.error", { message, raw: messageEvent.data });
      }
    };

    return socket;
  }

  function sendQueuedHumeMessages() {
    const socket = connectHumeSocket();
    if (socket.readyState !== WebSocket.OPEN) return;

    while (humeMessageQueueRef.current.length > 0) {
      const item = humeMessageQueueRef.current.shift();
      socket.send(JSON.stringify({
        type: "speak",
        text: item.text,
        voiceGender: item.voiceGender,
        emotion: item.emotion,
        intensity: item.intensity,
        speakingStyle: item.speakingStyle,
        lipSync: item.lipSync,
      }));
      setHumeStatus(`Streaming ${item.voiceGender} text to Hume Octave...`);
      updateHumeDebug({
        selectedVoiceGender: item.voiceGender,
        streamingStatus: "sending_text",
        latestTextChunk: item.text,
        latestActingInstruction: item.actingInstruction,
      });
      appendLog("hume.text.sent", {
        voiceGender: item.voiceGender,
        text: item.text,
        actingInstruction: item.actingInstruction,
      });
    }
  }

  function handleHumeMessage(message) {
    if (message.type === "hume.connection.open") {
      setHumeStatus("Hume Octave connected");
      updateHumeDebug({
        connectionStatus: "connected",
        streamingStatus: "ready",
      });
      appendLog("hume.connection.opened", {});
      return;
    }

    if (message.type === "hume.request.accepted") {
      setHumeStatus("Hume Octave generating audio...");
      setHumeError("");
      setLipSyncPlaceholder(message.lipSync || HUME_LIP_SYNC_PLACEHOLDER);
      updateHumeDebug({
        selectedVoiceGender: message.voiceGender,
        maskedVoiceId: message.maskedVoiceId || "configured",
        streamingStatus: "generating",
        latestTextChunk: message.text || "",
        latestActingInstruction: message.actingInstruction || "",
        latestError: "",
      });
      appendLog("hume.request.accepted", {
        voiceGender: message.voiceGender,
        maskedVoiceId: message.maskedVoiceId,
        text: message.text,
        actingInstruction: message.actingInstruction,
      });
      return;
    }

    if (message.type === "hume.audio") {
      setHumeStatus("Hume Octave audio received");
      setLipSyncPlaceholder(message.lipSync || HUME_LIP_SYNC_PLACEHOLDER);
      updateHumeDebug({
        streamingStatus: message.isLastChunk ? "last_audio_chunk" : "receiving_audio",
      });
      appendLog("hume.audio.chunk", {
        chunkIndex: message.chunkIndex,
        isLastChunk: message.isLastChunk,
        audioFormat: message.audioFormat,
        text: message.text,
      });
      enqueueHumeAudioChunk(message.audio, message.audioFormat);
      return;
    }

    if (message.type === "hume.metadata") {
      if (message.lipSync) {
        setLipSyncPlaceholder(message.lipSync);
        appendLog("hume.lip_sync.placeholder", message.lipSync);
      }
      appendLog("hume.metadata", message.metadata || message.raw || {});
      return;
    }

    if (message.type === "hume.error") {
      const errorMessage = message.error || "Hume Octave error.";
      setHumeError(errorMessage);
      setHumeStatus("Hume Octave error");
      updateHumeDebug({
        streamingStatus: "error",
        latestError: errorMessage,
      });
      appendLog("hume.error", { message: errorMessage, status: message.status });
      return;
    }

    if (message.type === "hume.connection.closed") {
      updateHumeDebug({
        connectionStatus: "disconnected",
        streamingStatus: "idle",
      });
      appendLog("hume.connection.closed", {
        code: message.code,
        reason: message.reason,
      });
    }
  }

  function enqueueHumeAudioChunk(base64Audio, audioFormat) {
    if (!base64Audio) return;

    try {
      const url = base64ToBlobUrl(base64Audio, audioFormat);
      humeAudioQueueRef.current.push({ url });
      processHumeAudioQueue();
    } catch (error) {
      const message = error.message || "Could not decode Hume audio chunk.";
      setHumeError(message);
      updateHumeDebug({
        playbackStatus: "error",
        latestError: message,
      });
      appendLog("hume.error", { message });
    }
  }

  function processHumeAudioQueue() {
    if (humeAudioPlayingRef.current) return;
    const nextAudio = humeAudioQueueRef.current.shift();
    if (!nextAudio) {
      updateHumeDebug({ playbackStatus: "idle" });
      return;
    }

    humeAudioPlayingRef.current = true;
    const audio = new Audio(nextAudio.url);
    humeCurrentAudioRef.current = audio;
    updateHumeDebug({ playbackStatus: "playing" });
    appendLog("hume.playback.start", {});

    audio.onended = () => {
      URL.revokeObjectURL(nextAudio.url);
      humeAudioPlayingRef.current = false;
      humeCurrentAudioRef.current = null;
      updateHumeDebug({ playbackStatus: "ended" });
      appendLog("hume.playback.end", {});
      processHumeAudioQueue();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(nextAudio.url);
      humeAudioPlayingRef.current = false;
      humeCurrentAudioRef.current = null;
      const message = "Browser could not play a Hume audio chunk.";
      setHumeError(message);
      updateHumeDebug({
        playbackStatus: "error",
        latestError: message,
      });
      appendLog("hume.error", { message });
      processHumeAudioQueue();
    };

    audio.play().catch((error) => {
      URL.revokeObjectURL(nextAudio.url);
      humeAudioPlayingRef.current = false;
      humeCurrentAudioRef.current = null;
      const message = error.message || "Browser blocked Hume audio playback.";
      setHumeError(message);
      updateHumeDebug({
        playbackStatus: "error",
        latestError: message,
      });
      appendLog("hume.error", { message });
    });
  }

  function upsertToolCall(callId, updater) {
    setToolCalls((calls) => {
      const existingCall = calls.find((call) => call.id === callId);

      if (!existingCall) {
        const now = getTimestamp();
        const rawArguments = "";
        const parsed = safeJsonParse(rawArguments);
        const nextCall = updater({
          id: callId,
          name: "unknown",
          rawArguments,
          parsedArguments: parsed.parsed,
          jsonParseError: parsed.error,
          status: "streaming",
          createdAt: now,
          updatedAt: now,
        });

        return [nextCall, ...calls];
      }

      return calls.map((call) => (call.id === callId ? updater(call) : call));
    });
  }

  function appendToolCallDelta(callId, functionName, argumentsDelta) {
    upsertToolCall(callId, (call) => {
      const rawArguments = `${call.rawArguments}${argumentsDelta || ""}`;
      const parsed = safeJsonParse(rawArguments);

      return {
        ...call,
        name: functionName && functionName !== "unknown" ? functionName : call.name,
        rawArguments,
        parsedArguments: parsed.parsed,
        jsonParseError: parsed.error,
        status: "streaming",
        updatedAt: getTimestamp(),
      };
    });
  }

  function finalizeToolCall(callId, functionName, completedArguments) {
    upsertToolCall(callId, (call) => {
      const rawArguments =
        typeof completedArguments === "string" ? completedArguments : call.rawArguments;
      const parsed = safeJsonParse(rawArguments);

      if (!parsed.error && parsed.parsed && typeof parsed.parsed === "object") {
        latestAvatarStateRef.current = parsed.parsed;
        const nextLipSync = {
          ...HUME_LIP_SYNC_PLACEHOLDER,
          ...(parsed.parsed.lipSync || {}),
          enabled: false,
          source: "hume_octave",
          mode: "placeholder",
        };
        setLipSyncPlaceholder(nextLipSync);
        appendLog("tool.function_call.json", {
          name: functionName && functionName !== "unknown" ? functionName : call.name,
          arguments: parsed.parsed,
        });
        appendLog("hume.lip_sync.placeholder", nextLipSync);
      }

      return {
        ...call,
        name: functionName && functionName !== "unknown" ? functionName : call.name,
        rawArguments,
        parsedArguments: parsed.parsed,
        jsonParseError: parsed.error,
        status: parsed.error ? "error" : "completed",
        updatedAt: getTimestamp(),
      };
    });
  }

  function handleRealtimeEvent(event) {
    appendRealtimeEvent(event);

    const speechDelta = getAssistantSpeechDelta(event);
    if (speechDelta) {
      updateSpeechText(speechDelta);
    }

    const speechFinal = getAssistantSpeechFinal(event);
    if (speechFinal) {
      finalizeSpeechText(speechFinal);
    }

    if (event.type === "response.created") {
      currentSpeechBufferRef.current = "";
      sentenceSpeechBufferRef.current = "";
      sentSentenceChunksRef.current = new Set();
      setCurrentSpeechText("");
    }

    if (event.type === "response.function_call_arguments.delta") {
      appendToolCallDelta(getToolCallKey(event), extractFunctionName(event), extractArgumentsDelta(event));
    }

    if (event.type === "response.function_call_arguments.done") {
      finalizeToolCall(getToolCallKey(event), extractFunctionName(event), extractCompletedArguments(event));
    }

    if (
      (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
      event.item?.type === "function_call"
    ) {
      const callId = event.item.call_id || event.item.id || getToolCallKey(event);
      const completedArguments = event.type === "response.output_item.done" ? event.item.arguments : null;

      if (completedArguments !== null) {
        finalizeToolCall(callId, extractFunctionName(event), completedArguments);
      } else {
        appendToolCallDelta(callId, extractFunctionName(event), "");
      }
    }

    if (event.type === "response.done") {
      const outputItems = event.response?.output || [];

      outputItems.forEach((item) => {
        if (item.type === "function_call") {
          finalizeToolCall(item.call_id || item.id || getToolCallKey(event), item.name, item.arguments);
        }

        const transcript = item.content
          ?.map((contentPart) => contentPart.transcript || contentPart.text || "")
          .join("");

        if (transcript) {
          finalizeSpeechText(transcript);
        }
      });
    }
  }

  async function startConversation() {
    if (isRunning) return;

    try {
      setStatus("Requesting microphone...");

      // The browser captures mic audio. WebRTC sends it directly over the peer connection.
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;

      setStatus("Creating peer connection...");
      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      // OpenAI Realtime is used for conversation and text extraction only.
      peerConnection.ontrack = (event) => {
        event.track.enabled = false;
        appendLog("debug.realtime_audio_track_ignored", {
          message: "Realtime audio output is ignored so only Hume Octave audio is played.",
        });
      };

      localStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      const eventChannel = peerConnection.createDataChannel("oai-events");
      eventChannelRef.current = eventChannel;
      eventChannel.onopen = () => {
        appendRealtimeEvent({ type: "debug.data_channel.open" });
      };
      eventChannel.onclose = () => {
        appendRealtimeEvent({ type: "debug.data_channel.close" });
      };
      eventChannel.onerror = (error) => {
        appendRealtimeEvent({
          type: "error",
          error: {
            message: error.message || "Realtime data channel error",
          },
        });
      };
      eventChannel.onmessage = (messageEvent) => {
        try {
          handleRealtimeEvent(JSON.parse(messageEvent.data));
        } catch (error) {
          appendRealtimeEvent({
            type: "error",
            error: {
              message: "Could not parse realtime event",
              raw: messageEvent.data,
              details: error.message,
            },
          });
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      setStatus("Negotiating secure session...");
      const response = await fetch("/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sdp: offer.sdp,
          scenario,
          enableSampleTool,
        }),
      });

      if (!response.ok) {
        let errorMessage = "Could not create realtime session";

        if (response.status === 404) {
          errorMessage = "Session route is missing. Expected POST /api/session.";
        } else {
          const errorBody = await response.text();

          try {
            const parsedError = JSON.parse(errorBody);
            errorMessage = parsedError.error || parsedError.message || errorBody || errorMessage;
          } catch {
            errorMessage = errorBody || errorMessage;
          }
        }

        throw new Error(errorMessage);
      }

      const answerSdp = await response.text();
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setIsRunning(true);
      setStatus("Connected. Start speaking.");
    } catch (error) {
      console.error(error);
      stopConversation();
      setStatus(`Error: ${error.message || "Could not start conversation"}`);
    }
  }

  function stopConversation() {
    // Stop microphone capture.
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    // Close the WebRTC connection.
    eventChannelRef.current?.close();
    eventChannelRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    // Clear remote audio playback.
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    clearHumePlayback();

    setIsRunning(false);
    setStatus("Idle");
  }

  return (
    <main className="app">
      <section className="panel">
        <label htmlFor="scenario">Conversation scenario</label>
        <textarea
          id="scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
          disabled={isRunning}
        />

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enableSampleTool}
            onChange={(event) => setEnableSampleTool(event.target.checked)}
            disabled={isRunning}
          />
          Enable sample avatar tool schema
        </label>

        <div className="settings-row">
          <label htmlFor="voice-gender">Voice</label>
          <select
            id="voice-gender"
            value={voiceGender}
            onChange={(event) => setVoiceGender(event.target.value)}
          >
            {VOICE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-group" aria-label="Logs">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={enableResponseLogs}
              onChange={(event) => setEnableResponseLogs(event.target.checked)}
            />
            Enable response logs
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={showLogPanel}
              onChange={(event) => setShowLogPanel(event.target.checked)}
            />
            Show log panel
          </label>
          <button className="secondary-button compact-button" onClick={() => setEventLog([])} type="button">
            Clear logs
          </button>
        </div>

        <div className="controls">
          <button onClick={startConversation} disabled={isRunning}>
            Start Conversation
          </button>
          <button onClick={stopConversation}>Stop / Reset</button>
        </div>

        <p className="status">Status: {status}</p>
        <p className="status">TTS: {humeStatus}</p>
        {humeError && <p className="error-message">{humeError}</p>}
      </section>

      {showLogPanel && <section className="debug-panel" aria-label="Debug Inspector">
        <div className="section-heading">
          <div>
            <h1>Debug / Inspector</h1>
            <p>Realtime speech text, tool arguments, and event previews.</p>
          </div>
        </div>

        <section className="debug-section">
          <div className="section-heading">
            <h2>AI Speech Text</h2>
            <CopyButton value={finalSpeechText || currentSpeechText} label="Copy latest" />
          </div>

          <div className="speech-grid">
            <div>
              <h3>Streaming</h3>
              <pre className="text-block">{currentSpeechText || "No streaming speech text yet."}</pre>
            </div>
            <div>
              <h3>Final</h3>
              <pre className="text-block">{finalSpeechText || "No completed AI speech text yet."}</pre>
            </div>
          </div>

          {speechHistory.length > 0 && (
            <div className="history-list">
              <h3>Recent Finals</h3>
              {speechHistory.map((item) => (
                <article className="history-item" key={item.id}>
                  <time>{item.timestamp}</time>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="debug-section">
          <div className="section-heading">
            <h2>Hume Octave TTS</h2>
          </div>

          <dl className="metadata-grid hume-metadata-grid">
            <div>
              <dt>Voice gender</dt>
              <dd>{humeDebug.selectedVoiceGender}</dd>
            </div>
            <div>
              <dt>Masked voice ID</dt>
              <dd>{humeDebug.maskedVoiceId}</dd>
            </div>
            <div>
              <dt>Connection</dt>
              <dd>{humeDebug.connectionStatus}</dd>
            </div>
            <div>
              <dt>Streaming</dt>
              <dd>{humeDebug.streamingStatus}</dd>
            </div>
            <div>
              <dt>Playback</dt>
              <dd>{humeDebug.playbackStatus}</dd>
            </div>
            <div>
              <dt>Lip-sync placeholder</dt>
              <dd>{humeDebug.hasLipSyncPlaceholder ? "available" : "missing"}</dd>
            </div>
          </dl>

          <div className="speech-grid">
            <div>
              <h3>Latest text sent</h3>
              <pre className="text-block">{humeDebug.latestTextChunk || "No text sent to Hume yet."}</pre>
            </div>
            <div>
              <h3>Latest acting instruction</h3>
              <pre className="text-block">
                {humeDebug.latestActingInstruction || "No acting instruction sent yet."}
              </pre>
            </div>
          </div>

          {humeDebug.latestError && <p className="error-message">{humeDebug.latestError}</p>}
        </section>

        <section className="debug-section">
          <div className="section-heading">
            <h2>Tool Calls</h2>
          </div>

          {toolCalls.length === 0 ? (
            <p className="empty-state">No tool or function calls received yet.</p>
          ) : (
            <div className="tool-call-list">
              {toolCalls.map((toolCall) => {
                const parsedJson = toolCall.parsedArguments
                  ? JSON.stringify(toolCall.parsedArguments, null, 2)
                  : "";
                const jsonStatus = getJsonParseStatus(toolCall);

                return (
                  <article className="tool-call" key={toolCall.id}>
                    <div className="tool-call-header">
                      <div>
                        <h3>Tool: {toolCall.name}</h3>
                        <p>Call ID: {toolCall.id}</p>
                      </div>
                      <span className={`status-pill ${toolCall.status}`}>{toolCall.status}</span>
                    </div>

                    <dl className="metadata-grid">
                      <div>
                        <dt>JSON status</dt>
                        <dd>{jsonStatus}</dd>
                      </div>
                      <div>
                        <dt>Created</dt>
                        <dd>{toolCall.createdAt}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>{toolCall.updatedAt}</dd>
                      </div>
                    </dl>

                    <div className="code-block-header">
                      <h4>Raw arguments</h4>
                      <CopyButton value={toolCall.rawArguments} />
                    </div>
                    <pre className="code-block">{toolCall.rawArguments || "No argument text received yet."}</pre>

                    <div className="code-block-header">
                      <h4>Parsed JSON</h4>
                      <CopyButton value={parsedJson} disabled={!parsedJson} />
                    </div>
                    <pre className="code-block">
                      {parsedJson ||
                        (jsonStatus === "pending"
                          ? "Waiting for complete JSON."
                          : toolCall.jsonParseError || "Waiting for valid JSON.")}
                    </pre>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="debug-section">
          <div className="section-heading">
            <h2>Lip Sync Placeholder JSON</h2>
            <CopyButton value={JSON.stringify(lipSyncPlaceholder, null, 2)} />
          </div>
          <pre className="code-block">{JSON.stringify(lipSyncPlaceholder, null, 2)}</pre>
        </section>

        <section className="debug-section">
          <div className="section-heading">
            <h2>Realtime Events</h2>
            <button className="secondary-button" onClick={() => setEventLog([])} type="button">
              Clear log
            </button>
          </div>

          <div className="event-log">
            {eventLog.length === 0 ? (
              <p className="empty-state">No relevant realtime events logged yet.</p>
            ) : (
              eventLog.map((item) => (
                <article className="event-item" key={item.id}>
                  <div className="event-summary">
                    <strong>{item.type}</strong>
                    <time>{item.timestamp}</time>
                  </div>
                  <pre className="code-block">{JSON.stringify(item.preview, null, 2)}</pre>
                </article>
              ))
            )}
          </div>
        </section>
      </section>}

      <audio ref={remoteAudioRef} autoPlay playsInline />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
