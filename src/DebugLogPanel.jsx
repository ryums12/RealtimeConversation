function getJsonParseStatus(toolCall) {
  if (!toolCall.rawArguments || (toolCall.status === "streaming" && toolCall.jsonParseError)) {
    return "pending";
  }

  return toolCall.jsonParseError ? "invalid JSON" : "valid JSON";
}

function getLogEntryClassName(type) {
  if (type === "user_speech") return "user-log";
  if (type === "ai_response") return "ai-log";

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

export function DebugLogPanel({
  currentSpeechText,
  currentUserSpeechText,
  eventLog,
  finalSpeechText,
  finalUserSpeechText,
  lipSyncPlaceholder,
  onClearLogs,
  speechHistory,
  toolCalls,
  TTSDebug,
}) {
  const conversationLogItems = eventLog
    .filter((item) => item.type === "user_speech" || item.type === "ai_response")
    .slice()
    .reverse();

  return (
    <section className="debug-panel" aria-label="Debug Inspector">
      <div className="section-heading">
        <div>
          <h1>Debug / Inspector</h1>
          <p>User and AI transcript logs, tool arguments, TTS, and event previews.</p>
        </div>
      </div>

      <section className="debug-section">
        <div className="section-heading">
          <h2>Conversation Logs</h2>
          <CopyButton
            value={conversationLogItems
              .map((item) => `[${item.timestamp}] ${item.preview?.label || item.type}\n${item.preview?.text || ""}`)
              .join("\n\n")}
            label="Copy transcript"
            disabled={conversationLogItems.length === 0}
          />
        </div>

        <div className="speech-grid">
          <div>
            <h3>User Streaming</h3>
            <pre className="text-block">{currentUserSpeechText || "No streaming user transcript yet."}</pre>
          </div>
          <div>
            <h3>User Final</h3>
            <pre className="text-block">{finalUserSpeechText || "No completed user transcript yet."}</pre>
          </div>
        </div>

        <div className="conversation-log">
          {conversationLogItems.length === 0 ? (
            <p className="empty-state">No user or AI transcript logs yet.</p>
          ) : (
            conversationLogItems.map((item) => (
              <article className={`conversation-item ${getLogEntryClassName(item.type)}`} key={item.id}>
                <div className="conversation-meta">
                  <strong>{item.preview?.label || item.type}</strong>
                  <time>{item.timestamp}</time>
                </div>
                <p>{item.preview?.text || ""}</p>
              </article>
            ))
          )}
        </div>
      </section>

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
          <h2>TTS</h2>
        </div>

        <div className="speech-grid">
          <div>
            <h3>Latest text sent</h3>
            <pre className="text-block">{TTSDebug.latestTextChunk || "No text sent to TTS yet."}</pre>
          </div>
          <div>
            <h3>Latest acting instruction</h3>
            <pre className="text-block">
              {TTSDebug.latestActingInstruction || "No acting instruction sent yet."}
            </pre>
          </div>
        </div>

        {TTSDebug.latestError && <p className="error-message">{TTSDebug.latestError}</p>}
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
          <button className="secondary-button" onClick={onClearLogs} type="button">
            Clear log
          </button>
        </div>

        <div className="event-log">
          {eventLog.length === 0 ? (
            <p className="empty-state">No relevant realtime events logged yet.</p>
          ) : (
            eventLog.map((item) => (
              <article className={`event-item ${getLogEntryClassName(item.type)}`} key={item.id}>
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
    </section>
  );
}
