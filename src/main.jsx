import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const MAX_EVENT_LOG_ITEMS = 150;
const MAX_SPEECH_HISTORY_ITEMS = 6;
const VOICE_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
];

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
  const [voiceboxStatus, setVoiceboxStatus] = useState("Voicebox idle");
  const [voiceboxError, setVoiceboxError] = useState("");
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
  const voiceboxAudioRef = useRef(null);
  const voiceboxQueueRef = useRef([]);
  const voiceboxIsPlayingRef = useRef(false);
  const voiceboxPlaybackResolveRef = useRef(null);
  const voiceboxRunIdRef = useRef(0);
  const voiceGenderRef = useRef(voiceGender);
  const enableResponseLogsRef = useRef(enableResponseLogs);
  const currentSpeechBufferRef = useRef("");
  const lastFinalSpeechRef = useRef("");

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
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
  }

  function finalizeSpeechText(text) {
    const completedText = text || currentSpeechBufferRef.current;
    if (!completedText || completedText === lastFinalSpeechRef.current) return;

    currentSpeechBufferRef.current = "";
    lastFinalSpeechRef.current = completedText;
    setCurrentSpeechText("");
    setFinalSpeechText(completedText);
    appendLog("assistant.speech.final", { text: completedText });
    enqueueVoiceboxSpeech(completedText);
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

  function clearVoiceboxPlayback() {
    voiceboxRunIdRef.current += 1;
    voiceboxQueueRef.current = [];
    voiceboxPlaybackResolveRef.current?.();
    voiceboxPlaybackResolveRef.current = null;

    if (voiceboxAudioRef.current) {
      voiceboxAudioRef.current.pause();
      voiceboxAudioRef.current.removeAttribute("src");
      voiceboxAudioRef.current.load();
      voiceboxAudioRef.current = null;
    }

    voiceboxIsPlayingRef.current = false;
    setVoiceboxStatus("Voicebox idle");
  }

  function enqueueVoiceboxSpeech(text) {
    const trimmedText = text?.trim();
    if (!trimmedText) return;

    voiceboxQueueRef.current.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: trimmedText,
      voiceGender: voiceGenderRef.current,
    });
    processVoiceboxQueue();
  }

  async function processVoiceboxQueue() {
    if (voiceboxIsPlayingRef.current) return;
    voiceboxIsPlayingRef.current = true;
    const runId = voiceboxRunIdRef.current;

    while (voiceboxQueueRef.current.length > 0 && runId === voiceboxRunIdRef.current) {
      const item = voiceboxQueueRef.current.shift();
      setVoiceboxError("");
      setVoiceboxStatus(`Generating ${item.voiceGender} Voicebox audio...`);
      appendLog("voicebox.generate.request", {
        voiceGender: item.voiceGender,
        language: "ko",
        text: item.text,
      });

      try {
        const generateResponse = await fetch("/api/voicebox/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: item.text,
            voiceGender: item.voiceGender,
            language: "ko",
          }),
        });

        const responseText = await generateResponse.text();
        let responseBody = {};

        try {
          responseBody = responseText ? JSON.parse(responseText) : {};
        } catch {
          responseBody = { body: responseText };
        }

        if (runId !== voiceboxRunIdRef.current) return;

        if (!generateResponse.ok) {
          throw new Error(
            responseBody.error ||
              `Voicebox generation failed with HTTP ${generateResponse.status}: ${responseText}`
          );
        }

        const generationId = responseBody.generationId;
        if (!generationId) {
          throw new Error("Voicebox generation succeeded but did not return a generation ID.");
        }

        appendLog("voicebox.generate.success", {
          generationId,
          voiceGender: item.voiceGender,
          profileId: responseBody.profileId,
        });

        setVoiceboxStatus(`Playing ${item.voiceGender} Voicebox audio...`);
        await playVoiceboxAudio(generationId, runId);
      } catch (error) {
        if (runId !== voiceboxRunIdRef.current) return;
        const message = error.message || "Voicebox playback failed.";
        setVoiceboxError(message);
        setVoiceboxStatus("Voicebox error");
        appendLog("voicebox.error", { message });
      }
    }

    if (runId === voiceboxRunIdRef.current) {
      voiceboxIsPlayingRef.current = false;
      setVoiceboxStatus("Voicebox idle");
    }
  }

  async function playVoiceboxAudio(generationId, runId) {
    appendLog("voicebox.audio.start", { generationId });

    await new Promise((resolve, reject) => {
      const audio = new Audio(`/api/voicebox/audio/${encodeURIComponent(generationId)}`);
      voiceboxAudioRef.current = audio;
      voiceboxPlaybackResolveRef.current = resolve;

      audio.onended = resolve;
      audio.onerror = () => reject(new Error("Voicebox audio playback failed."));
      audio.play().catch(reject);
    });

    if (runId === voiceboxRunIdRef.current) {
      appendLog("voicebox.audio.end", { generationId });
    }
    voiceboxPlaybackResolveRef.current = null;
    voiceboxAudioRef.current = null;
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
          message: "Realtime audio output is ignored so only Voicebox audio is played.",
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
    clearVoiceboxPlayback();

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
        <p className="status">TTS: {voiceboxStatus}</p>
        {voiceboxError && <p className="error-message">{voiceboxError}</p>}
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
