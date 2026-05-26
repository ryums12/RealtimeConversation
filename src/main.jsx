import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationAnalysisPanel } from "./ConversationAnalysisPanel.jsx";
import "./styles.css";

const MAX_EVENT_LOG_ITEMS = 150;
const MAX_SPEECH_HISTORY_ITEMS = 6;
const DEFAULT_TURN_DETECTION_SETTINGS = {
  type: "semantic_vad",
  eagerness: "low",
  silence_duration_ms: null,
  prefix_padding_ms: null,
  threshold: null,
  create_response: true,
};
const TURN_LIFECYCLE_EVENT_TYPES = new Set([
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
  "response.created",
  "response.done",
]);
const VOICE_OPTIONS = [
  { value: "male", label: "남성" },
  { value: "female", label: "여성" },
];
const TTS_LIP_SYNC_PLACEHOLDER = {
  enabled: false,
  source: "tts",
  mode: "placeholder",
  timestampsAvailable: false,
  wordTimestamps: [],
  phonemeTimestamps: [],
  visemes: [],
};

async function readApiError(response, fallbackMessage) {
  const body = await response.text();

  if (!body) return fallbackMessage;

  try {
    const parsed = JSON.parse(body);
    return parsed.error || parsed.message || fallbackMessage;
  } catch {
    return body || fallbackMessage;
  }
}

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

function formatKstTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} KST`;
}

function getTimestamp() {
  return formatKstTimestamp();
}

function buildTTSActingInstruction({
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

function getTTSSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/tts/stream`;
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
    event_id: event.event_id,
    response_id: event.response_id,
    item_id: event.item_id,
    previous_item_id: event.previous_item_id,
    call_id: event.call_id,
    output_index: event.output_index,
    content_index: event.content_index,
    delta: event.delta,
    transcript: event.transcript,
    text: event.text,
    arguments: event.arguments,
    error: event.error,
    item: event.item,
    response: event.response
      ? {
          id: event.response.id,
          status: event.response.status,
          status_details: event.response.status_details,
        }
      : undefined,
  };
}

function isRelevantRealtimeEvent(event) {
  if (!event?.type) return false;

  return (
    TURN_LIFECYCLE_EVENT_TYPES.has(event.type) ||
    event.type === "conversation.item.done" ||
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

function getUserSpeechTranscriptDelta(event) {
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    return event.delta || "";
  }

  return "";
}

function getUserSpeechTranscriptFinal(event) {
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    return event.transcript || "";
  }

  if (event.type === "conversation.item.done" && event.item?.role === "user") {
    return extractUserTranscriptFromItem(event.item);
  }

  return "";
}

function extractUserTranscriptFromItem(item) {
  if (!item || item.role !== "user" || !Array.isArray(item.content)) return "";

  return item.content
    .map((contentPart) => contentPart.transcript || contentPart.text || "")
    .join("")
    .trim();
}

function App() {
  const [scenario, setScenario] = useState(
        "당신은 사용자의 이웃집 사람이다. 평범한 사람을 연기하되, 사용자가 하는 말에 따라서 감정 변화를 드러내도록 한다."
  );
  const [enableSampleTool, setEnableSampleTool] = useState(false);
  const [voiceGender, setVoiceGender] = useState("male");
  const [enableResponseLogs] = useState(true);
  const [conversationId, setConversationId] = useState("");
  const [conversationStatus, setConversationStatus] = useState("idle");
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisStatusMessage, setAnalysisStatusMessage] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [TTSStatus, setTTSStatus] = useState("TTS idle");
  const [TTSError, setTTSError] = useState("");
  const [TTSDebug, setTTSDebug] = useState({
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
  const [lipSyncPlaceholder, setLipSyncPlaceholder] = useState(TTS_LIP_SYNC_PLACEHOLDER);
  const [isRunning, setIsRunning] = useState(false);
  const [currentUserSpeechText, setCurrentUserSpeechText] = useState("");
  const [finalUserSpeechText, setFinalUserSpeechText] = useState("");
  const [currentSpeechText, setCurrentSpeechText] = useState("");
  const [finalSpeechText, setFinalSpeechText] = useState("");
  const [speechHistory, setSpeechHistory] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [eventLog, setEventLog] = useState([]);
  const [turnDetectionSettings, setTurnDetectionSettings] = useState(DEFAULT_TURN_DETECTION_SETTINGS);

  const peerConnectionRef = useRef(null);
  const eventChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const TTSSocketRef = useRef(null);
  const TTSMessageQueueRef = useRef([]);
  const TTSRunIdRef = useRef(0);
  const TTSAudioQueueRef = useRef([]);
  const TTSAudioPlayingRef = useRef(false);
  const TTSCurrentAudioRef = useRef(null);
  const voiceGenderRef = useRef(voiceGender);
  const conversationIdRef = useRef(conversationId);
  const conversationStatusRef = useRef(conversationStatus);
  const enableResponseLogsRef = useRef(enableResponseLogs);
  const currentSpeechBufferRef = useRef("");
  const sentenceSpeechBufferRef = useRef("");
  const sentSentenceChunksRef = useRef(new Set());
  const lastFinalSpeechRef = useRef("");
  const userTranscriptBuffersRef = useRef(new Map());
  const finalizedUserTranscriptKeysRef = useRef(new Set());
  const latestAvatarStateRef = useRef({});
  const turnStateRef = useRef({
    activeResponseId: null,
    lastCommittedItemId: null,
    lastSpeechStartedAt: null,
    lastSpeechStoppedAt: null,
    responseIdsByItemId: new Map(),
  });

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
    setTTSDebug((debug) => ({
      ...debug,
      selectedVoiceGender: voiceGender,
    }));
    appendLog("tts.voice.selected", { voiceGender });
  }, [voiceGender]);

  useEffect(() => {
    enableResponseLogsRef.current = enableResponseLogs;
  }, [enableResponseLogs]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    conversationStatusRef.current = conversationStatus;
  }, [conversationStatus]);

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

  async function createConversationRecord() {
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scenario,
          metadata: {
            enableSampleTool,
            voiceGender,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not create a saved conversation."));
      }

      const payload = await response.json();
      setConversationId(payload.conversationId || "");
      conversationIdRef.current = payload.conversationId || "";
      appendLog("conversation.created", { conversationId: payload.conversationId });
      return payload.conversationId || "";
    } catch (error) {
      const message = error.message || "Could not create a saved conversation.";
      setAnalysisError(`${message} Conversation analysis will be unavailable until a conversation is saved.`);
      appendLog("conversation.create.error", { message });
      return "";
    }
  }

  async function persistConversationMessage(role, content, metadata = {}) {
    const activeConversationId = conversationIdRef.current;
    if (!activeConversationId || !content?.trim()) return;

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(activeConversationId)}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role,
          content,
          metadata,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not save conversation message."));
      }
    } catch (error) {
      appendLog("conversation.message.save.error", {
        role,
        message: error.message || "Could not save conversation message.",
      });
    }
  }

  async function markConversationEnded() {
    const activeConversationId = conversationIdRef.current;
    if (!activeConversationId) return;

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(activeConversationId)}/end`, {
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not mark conversation as ended."));
      }

      appendLog("conversation.ended", { conversationId: activeConversationId });
    } catch (error) {
      const message = error.message || "Could not mark conversation as ended.";
      setAnalysisError(`${message} Analysis may be unavailable until the saved conversation is ended.`);
      appendLog("conversation.end.error", { message });
    }
  }

  function sendRealtimeClientEvent(event) {
    const eventChannel = eventChannelRef.current;
    if (eventChannel?.readyState !== "open") {
      appendLog("debug.realtime_client_event_skipped", {
        type: event.type,
        reason: "Realtime data channel is not open.",
      });
      return false;
    }

    eventChannel.send(JSON.stringify(event));
    appendLog("debug.realtime_client_event_sent", event);
    return true;
  }

  function getResponseId(event) {
    return event.response?.id || event.response_id || event.id || null;
  }

  function updateTurnDetectionFromHeader(response) {
    const encodedSettings = response.headers.get("X-Realtime-Turn-Detection");
    if (!encodedSettings) return;

    try {
      const settings = JSON.parse(decodeURIComponent(encodedSettings));
      setTurnDetectionSettings({
        silence_duration_ms: null,
        prefix_padding_ms: null,
        threshold: null,
        eagerness: null,
        ...settings,
      });
      appendLog("debug.turn_detection.settings", settings);
    } catch (error) {
      appendLog("error", {
        message: "Could not parse realtime turn detection settings.",
        details: error.message,
      });
    }
  }

  function handleTurnLifecycleEvent(event) {
    if (event.type === "input_audio_buffer.speech_started") {
      turnStateRef.current.lastSpeechStartedAt = getTimestamp();
      return false;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      turnStateRef.current.lastSpeechStoppedAt = getTimestamp();
      return false;
    }

    if (event.type === "input_audio_buffer.committed") {
      turnStateRef.current.lastCommittedItemId = event.item_id || null;
      appendLog("debug.user_input_committed", {
        item_id: turnStateRef.current.lastCommittedItemId,
        previous_item_id: event.previous_item_id,
      });
      return false;
    }

    if (event.type === "response.created") {
      const responseId = getResponseId(event);
      const activeResponseId = turnStateRef.current.activeResponseId;
      const itemId = turnStateRef.current.lastCommittedItemId || "unknown-input-item";

      if (activeResponseId && responseId && activeResponseId !== responseId) {
        appendLog("debug.duplicate_response_suppressed", {
          active_response_id: activeResponseId,
          duplicate_response_id: responseId,
          input_item_id: itemId,
        });
        sendRealtimeClientEvent({
          type: "response.cancel",
          response_id: responseId,
        });
        return true;
      }

      turnStateRef.current.activeResponseId = responseId || activeResponseId;
      if (responseId) {
        turnStateRef.current.responseIdsByItemId.set(itemId, responseId);
      }
      return false;
    }

    if (event.type === "response.done") {
      const responseId = getResponseId(event);
      if (!responseId || turnStateRef.current.activeResponseId === responseId) {
        turnStateRef.current.activeResponseId = null;
      }
    }

    return false;
  }

  function updateUserSpeechTranscript(event) {
    const delta = getUserSpeechTranscriptDelta(event);
    if (!delta) return;

    const itemId = event.item_id || "active-user-input";
    const existingText = userTranscriptBuffersRef.current.get(itemId) || "";
    const nextText = `${existingText}${delta}`;
    userTranscriptBuffersRef.current.set(itemId, nextText);
    setCurrentUserSpeechText(nextText);
  }

  function finalizeUserSpeechTranscript(event) {
    const transcript = getUserSpeechTranscriptFinal(event).trim();
    if (!transcript) return;

    const itemId = event.item_id || event.item?.id || "unknown-user-input";
    const contentIndex = event.content_index ?? 0;
    const transcriptKey = `${itemId}:${contentIndex}`;
    if (finalizedUserTranscriptKeysRef.current.has(transcriptKey)) return;

    finalizedUserTranscriptKeysRef.current.add(transcriptKey);
    userTranscriptBuffersRef.current.delete(itemId);
    setCurrentUserSpeechText("");
    setFinalUserSpeechText(transcript);
    appendLog("user_speech", {
      label: "User",
      text: transcript,
      item_id: itemId,
      source_event: event.type,
    });
    persistConversationMessage("user", transcript, {
      item_id: itemId,
      source_event: event.type,
    });
  }

  function updateSpeechText(deltaOrText) {
    if (!deltaOrText) return;

    currentSpeechBufferRef.current += deltaOrText;
    setCurrentSpeechText(currentSpeechBufferRef.current);
    appendLog("openai.realtime.text_delta", { text: deltaOrText });

    sentenceSpeechBufferRef.current += deltaOrText;
    const { chunks, remaining } = extractCompleteSentenceChunks(sentenceSpeechBufferRef.current);
    sentenceSpeechBufferRef.current = remaining;

    chunks.forEach((chunk) => enqueueTTSSpeech(chunk, "sentence_delta"));
  }

  function finalizeSpeechText(text) {
    const completedText = text || currentSpeechBufferRef.current;
    if (!completedText || completedText === lastFinalSpeechRef.current) return;

    currentSpeechBufferRef.current = "";
    lastFinalSpeechRef.current = completedText;
    setCurrentSpeechText("");
    setFinalSpeechText(completedText);
    appendLog("ai_response", { label: "AI", text: completedText });
    persistConversationMessage("assistant", completedText, {
      source: "openai.realtime",
    });

    const finalChunks = sentSentenceChunksRef.current.size > 0
      ? [sentenceSpeechBufferRef.current.trim()].filter(Boolean)
      : splitSpeechIntoChunks(completedText);
    sentenceSpeechBufferRef.current = "";
    finalChunks.forEach((chunk) => enqueueTTSSpeech(chunk, "final_text"));

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

  function updateTTSDebug(patch) {
    setTTSDebug((debug) => ({
      ...debug,
      ...patch,
      hasLipSyncPlaceholder: true,
    }));
  }

  function clearTTSPlayback() {
    TTSRunIdRef.current += 1;
    TTSMessageQueueRef.current = [];
    TTSAudioQueueRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    TTSAudioQueueRef.current = [];
    TTSAudioPlayingRef.current = false;
    TTSCurrentAudioRef.current?.pause();
    TTSCurrentAudioRef.current = null;

    if (TTSSocketRef.current?.readyState === WebSocket.OPEN) {
      TTSSocketRef.current.send(JSON.stringify({ type: "close" }));
      TTSSocketRef.current.close();
    }
    TTSSocketRef.current = null;

    setTTSStatus("TTS idle");
    updateTTSDebug({
      connectionStatus: "disconnected",
      streamingStatus: "idle",
      playbackStatus: "idle",
    });
  }

  function enqueueTTSSpeech(text, source) {
    const trimmedText = text?.trim();
    if (!trimmedText) return;
    if (sentSentenceChunksRef.current.has(trimmedText)) return;
    sentSentenceChunksRef.current.add(trimmedText);

    const emotionState = latestAvatarStateRef.current || {};
    const actingInstruction = buildTTSActingInstruction(emotionState);
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

    TTSMessageQueueRef.current.push(item);
    appendLog("tts.sentence_chunk.queued", {
      voiceGender: item.voiceGender,
      source,
      text: item.text,
      actingInstruction,
    });
    sendQueuedTTSMessages();
  }

  function connectTTSSocket() {
    const existingSocket = TTSSocketRef.current;
    if (existingSocket?.readyState === WebSocket.OPEN) return existingSocket;
    if (existingSocket?.readyState === WebSocket.CONNECTING) return existingSocket;

    setTTSError("");
    setTTSStatus("Connecting to TTS...");
    updateTTSDebug({
      connectionStatus: "connecting",
      streamingStatus: "connecting",
      latestError: "",
    });

    const socket = new WebSocket(getTTSSocketUrl());
    TTSSocketRef.current = socket;

    socket.onopen = () => {
      setTTSStatus("TTS connected");
      updateTTSDebug({
        connectionStatus: "connected",
        streamingStatus: "ready",
      });
      appendLog("tts.websocket.open", { endpoint: "/api/tts/stream" });
      sendQueuedTTSMessages();
    };

    socket.onclose = (event) => {
      setTTSStatus("TTS disconnected");
      updateTTSDebug({
        connectionStatus: "disconnected",
        streamingStatus: "idle",
      });
      appendLog("tts.websocket.closed", { code: event.code, reason: event.reason });
    };

    socket.onerror = () => {
      const message = "TTS proxy WebSocket failed.";
      setTTSError(message);
      setTTSStatus("TTS error");
      updateTTSDebug({
        connectionStatus: "error",
        streamingStatus: "error",
        latestError: message,
      });
      appendLog("tts.error", { message });
    };

    socket.onmessage = (messageEvent) => {
      try {
        handleTTSMessage(JSON.parse(messageEvent.data));
      } catch (error) {
        const message = error.message || "Could not parse TTS proxy message.";
        setTTSError(message);
        updateTTSDebug({ latestError: message });
        appendLog("tts.error", { message, raw: messageEvent.data });
      }
    };

    return socket;
  }

  function sendQueuedTTSMessages() {
    const socket = connectTTSSocket();
    if (socket.readyState !== WebSocket.OPEN) return;

    while (TTSMessageQueueRef.current.length > 0) {
      const item = TTSMessageQueueRef.current.shift();
      socket.send(JSON.stringify({
        type: "speak",
        text: item.text,
        voiceGender: item.voiceGender,
        emotion: item.emotion,
        intensity: item.intensity,
        speakingStyle: item.speakingStyle,
        lipSync: item.lipSync,
      }));
      setTTSStatus(`Streaming ${item.voiceGender} text to TTS...`);
      updateTTSDebug({
        selectedVoiceGender: item.voiceGender,
        streamingStatus: "sending_text",
        latestTextChunk: item.text,
        latestActingInstruction: item.actingInstruction,
      });
      appendLog("tts.text.sent", {
        voiceGender: item.voiceGender,
        text: item.text,
        actingInstruction: item.actingInstruction,
      });
    }
  }

  function handleTTSMessage(message) {
    if (message.type === "tts.connection.open") {
      setTTSStatus("TTS connected");
      updateTTSDebug({
        connectionStatus: "connected",
        streamingStatus: "ready",
      });
      appendLog("tts.connection.opened", {});
      return;
    }

    if (message.type === "tts.request.accepted") {
      setTTSStatus("TTS generating audio...");
      setTTSError("");
      setLipSyncPlaceholder(message.lipSync || TTS_LIP_SYNC_PLACEHOLDER);
      updateTTSDebug({
        selectedVoiceGender: message.voiceGender,
        maskedVoiceId: message.maskedVoiceId || "configured",
        streamingStatus: "generating",
        latestTextChunk: message.text || "",
        latestActingInstruction: message.actingInstruction || "",
        latestError: "",
      });
      appendLog("tts.request.accepted", {
        voiceGender: message.voiceGender,
        maskedVoiceId: message.maskedVoiceId,
        text: message.text,
        actingInstruction: message.actingInstruction,
      });
      return;
    }

    if (message.type === "tts.audio") {
      setTTSStatus("TTS audio received");
      setLipSyncPlaceholder(message.lipSync || TTS_LIP_SYNC_PLACEHOLDER);
      updateTTSDebug({
        streamingStatus: message.isLastChunk ? "last_audio_chunk" : "receiving_audio",
      });
      appendLog("tts.audio.chunk", {
        chunkIndex: message.chunkIndex,
        isLastChunk: message.isLastChunk,
        audioFormat: message.audioFormat,
        text: message.text,
      });
      enqueueTTSAudioChunk(message.audio, message.audioFormat);
      return;
    }

    if (message.type === "tts.metadata") {
      if (message.lipSync) {
        setLipSyncPlaceholder(message.lipSync);
        appendLog("tts.lip_sync.placeholder", message.lipSync);
      }
      appendLog("tts.metadata", message.metadata || message.raw || {});
      return;
    }

    if (message.type === "tts.error") {
      const errorMessage = message.error || "TTS error.";
      setTTSError(errorMessage);
      setTTSStatus("TTS error");
      updateTTSDebug({
        streamingStatus: "error",
        latestError: errorMessage,
      });
      appendLog("tts.error", { message: errorMessage, status: message.status });
      return;
    }

    if (message.type === "tts.connection.closed") {
      updateTTSDebug({
        connectionStatus: "disconnected",
        streamingStatus: "idle",
      });
      appendLog("tts.connection.closed", {
        code: message.code,
        reason: message.reason,
      });
    }
  }

  function enqueueTTSAudioChunk(base64Audio, audioFormat) {
    if (!base64Audio) return;

    try {
      const url = base64ToBlobUrl(base64Audio, audioFormat);
      TTSAudioQueueRef.current.push({ url });
      processTTSAudioQueue();
    } catch (error) {
      const message = error.message || "Could not decode TTS audio chunk.";
      setTTSError(message);
      updateTTSDebug({
        playbackStatus: "error",
        latestError: message,
      });
      appendLog("tts.error", { message });
    }
  }

  function processTTSAudioQueue() {
    if (TTSAudioPlayingRef.current) return;
    const nextAudio = TTSAudioQueueRef.current.shift();
    if (!nextAudio) {
      updateTTSDebug({ playbackStatus: "idle" });
      return;
    }

    TTSAudioPlayingRef.current = true;
    const audio = new Audio(nextAudio.url);
    TTSCurrentAudioRef.current = audio;
    updateTTSDebug({ playbackStatus: "playing" });

    audio.onended = () => {
      URL.revokeObjectURL(nextAudio.url);
      TTSAudioPlayingRef.current = false;
      TTSCurrentAudioRef.current = null;
      updateTTSDebug({ playbackStatus: "ended" });
      processTTSAudioQueue();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(nextAudio.url);
      TTSAudioPlayingRef.current = false;
      TTSCurrentAudioRef.current = null;
      const message = "Browser could not play a TTS audio chunk.";
      setTTSError(message);
      updateTTSDebug({
        playbackStatus: "error",
        latestError: message,
      });
      appendLog("tts.error", { message });
      processTTSAudioQueue();
    };

    audio.play().catch((error) => {
      URL.revokeObjectURL(nextAudio.url);
      TTSAudioPlayingRef.current = false;
      TTSCurrentAudioRef.current = null;
      const message = error.message || "Browser blocked TTS audio playback.";
      setTTSError(message);
      updateTTSDebug({
        playbackStatus: "error",
        latestError: message,
      });
      appendLog("tts.error", { message });
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
          ...TTS_LIP_SYNC_PLACEHOLDER,
          ...(parsed.parsed.lipSync || {}),
          enabled: false,
          source: "tts",
          mode: "placeholder",
        };
        setLipSyncPlaceholder(nextLipSync);
        appendLog("tool.function_call.json", {
          name: functionName && functionName !== "unknown" ? functionName : call.name,
          arguments: parsed.parsed,
        });
        appendLog("tts.lip_sync.placeholder", nextLipSync);
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
    const skipResponseProcessing = handleTurnLifecycleEvent(event);
    if (skipResponseProcessing) return;

    updateUserSpeechTranscript(event);
    finalizeUserSpeechTranscript(event);

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
      setConversationStatus("active");
      setConversationId("");
      conversationIdRef.current = "";
      setAnalysisResult(null);
      setAnalysisError("");
      setAnalysisStatusMessage("");
      await createConversationRecord();
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
          message: "Realtime audio output is ignored so only TTS audio is played.",
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

      updateTurnDetectionFromHeader(response);
      const answerSdp = await response.text();
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setIsRunning(true);
      setStatus("Connected. Start speaking.");
    } catch (error) {
      console.error(error);
      await stopConversation({ markEnded: false, resetConversation: true });
      setStatus(`Error: ${error.message || "Could not start conversation"}`);
    }
  }

  async function stopConversation({ markEnded = true, resetConversation = false } = {}) {
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
    clearTTSPlayback();
    turnStateRef.current = {
      activeResponseId: null,
      lastCommittedItemId: null,
      lastSpeechStartedAt: null,
      lastSpeechStoppedAt: null,
      responseIdsByItemId: new Map(),
    };
    userTranscriptBuffersRef.current = new Map();
    finalizedUserTranscriptKeysRef.current = new Set();

    setIsRunning(false);
    if (resetConversation) {
      setConversationId("");
      conversationIdRef.current = "";
      setConversationStatus("idle");
      setAnalysisResult(null);
      setAnalysisError("");
      setAnalysisStatusMessage("");
      setStatus("Idle");
    } else if (markEnded && conversationStatusRef.current === "active") {
      setConversationStatus("ended");
      setStatus("Conversation ended.");
      await markConversationEnded();
    } else {
      setStatus("Idle");
    }
    setCurrentUserSpeechText("");
  }

  async function analyzeConversation() {
    if (isAnalyzing) return;

    if (conversationStatus !== "ended") {
      setAnalysisError("End the conversation before requesting analysis.");
      return;
    }

    if (!conversationId) {
      setAnalysisError("No saved conversation ID exists for this conversation.");
      return;
    }

    if (!window.confirm("Do you want to analyze this conversation?")) return;

    setIsAnalyzing(true);
    setConversationStatus("analyzing");
    setAnalysisError("");
    setAnalysisStatusMessage("");

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/analyze`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Conversation analysis failed."));
      }

      const payload = await response.json();
      const nextAnalysisResult = payload.analysis || payload.result || "";

      if (!nextAnalysisResult || (typeof nextAnalysisResult === "object" && Object.keys(nextAnalysisResult).length === 0)) {
        throw new Error("Analysis completed, but the result was empty.");
      }

      setAnalysisResult(nextAnalysisResult);
      setAnalysisStatusMessage("Conversation analysis complete.");
      appendLog("conversation.analysis.completed", { conversationId });
    } catch (error) {
      setAnalysisError(error.message || "Conversation analysis failed.");
      appendLog("conversation.analysis.error", {
        conversationId,
        message: error.message || "Conversation analysis failed.",
      });
    } finally {
      setIsAnalyzing(false);
      setConversationStatus("ended");
    }
  }

  async function deleteConversation() {
    if (isDeletingConversation) return;

    if (conversationStatus !== "ended") {
      setAnalysisError("End the conversation before deleting its saved data.");
      return;
    }

    if (!window.confirm("Are you sure you want to cancel this conversation and delete its saved data?")) return;

    if (!conversationId) {
      setConversationId("");
      conversationIdRef.current = "";
      setConversationStatus("idle");
      setAnalysisResult(null);
      setAnalysisError("");
      setAnalysisStatusMessage("Conversation state cleared.");
      setEventLog([]);
      setStatus("Idle");
      return;
    }

    setIsDeletingConversation(true);
    setAnalysisError("");
    setAnalysisStatusMessage("");

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not delete conversation."));
      }

      setConversationId("");
      conversationIdRef.current = "";
      setConversationStatus("idle");
      setAnalysisResult(null);
      setAnalysisStatusMessage("Conversation deleted.");
      setEventLog([]);
      setSpeechHistory([]);
      setToolCalls([]);
      setFinalUserSpeechText("");
      setFinalSpeechText("");
      setCurrentSpeechText("");
      setStatus("Idle");
    } catch (error) {
      setAnalysisError(error.message || "Could not delete conversation.");
      appendLog("conversation.delete.error", {
        conversationId,
        message: error.message || "Could not delete conversation.",
      });
    } finally {
      setIsDeletingConversation(false);
    }
  }

  return (
    <main className="app">
      <section className="panel">
        <label htmlFor="scenario">대화 시나리오 설정</label>
        <textarea
          id="scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
          disabled={isRunning}
        />

        <div className="settings-row">
          <label htmlFor="voice-gender">성별 선택</label>
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

        <div className="controls">
          <button onClick={startConversation} disabled={isRunning}>
            대화 시작
          </button>
          <button onClick={stopConversation}>종료</button>
        </div>

        <p className="status">Status: {status}</p>
        <p className="status">TTS: {TTSStatus}</p>
        {TTSError && <p className="error-message">{TTSError}</p>}
      </section>

      <ConversationAnalysisPanel
        analysisError={analysisError}
        analysisResult={analysisResult}
        analysisStatusMessage={analysisStatusMessage}
        conversationId={conversationId}
        conversationStatus={conversationStatus}
        isAnalyzing={isAnalyzing}
        isDeleting={isDeletingConversation}
        onAnalyze={analyzeConversation}
        onDelete={deleteConversation}
      />

      <audio ref={remoteAudioRef} autoPlay playsInline />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);


