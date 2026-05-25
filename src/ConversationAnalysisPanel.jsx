function renderList(value, emptyText) {
  if (!Array.isArray(value) || value.length === 0) {
    return <p className="empty-state">{emptyText}</p>;
  }

  return (
    <ul className="analysis-list">
      {value.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function renderAnalysisResult(result) {
  if (!result) {
    return <p className="empty-state">No analysis result yet.</p>;
  }

  if (typeof result === "string") {
    return <p className="analysis-text">{result}</p>;
  }

  if (typeof result !== "object") {
    return <pre className="code-block">{String(result)}</pre>;
  }

  const metrics = result.metrics && typeof result.metrics === "object" ? result.metrics : null;

  return (
    <div className="analysis-result">
      {result.summary && (
        <section>
          <h3>Summary</h3>
          <p>{result.summary}</p>
        </section>
      )}

      <div className="analysis-grid">
        <section>
          <h3>Strengths</h3>
          {renderList(result.strengths, "No strengths were returned.")}
        </section>
        <section>
          <h3>Weaknesses</h3>
          {renderList(result.weaknesses, "No weaknesses were returned.")}
        </section>
      </div>

      <section>
        <h3>Improvement Suggestions</h3>
        {renderList(result.improvementSuggestions || result.suggestions, "No improvement suggestions were returned.")}
      </section>

      {(result.score !== undefined || metrics) && (
        <dl className="analysis-metrics">
          {result.score !== undefined && (
            <div>
              <dt>Score</dt>
              <dd>{result.score}</dd>
            </div>
          )}
          {metrics &&
            Object.entries(metrics).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  );
}

export function ConversationAnalysisPanel({
  analysisError,
  analysisResult,
  analysisStatusMessage,
  conversationId,
  conversationStatus,
  isAnalyzing,
  isDeleting,
  onAnalyze,
  onDelete,
}) {
  const isBusy = isAnalyzing || isDeleting || conversationStatus === "analyzing";
  const canAct = conversationStatus === "ended" && !isBusy;

  return (
    <section className="analysis-panel" aria-label="Conversation Analysis">
      <div className="section-heading">
        <div>
          <h2>Conversation Analysis</h2>
          <p>Status: {conversationStatus}</p>
        </div>
      </div>

      <div className="controls">
        <button onClick={onAnalyze} disabled={!canAct} type="button">
          Analyze Conversation
        </button>
        <button className="secondary-button" onClick={onDelete} disabled={!canAct} type="button">
          Cancel / Delete Conversation
        </button>
      </div>

      {!conversationId && conversationStatus === "ended" && (
        <p className="error-message">No saved conversation ID exists for this conversation.</p>
      )}
      {analysisStatusMessage && <p className="success-message">{analysisStatusMessage}</p>}
      {analysisError && <p className="error-message">{analysisError}</p>}

      <div className="analysis-result-box">{renderAnalysisResult(analysisResult)}</div>

      {isAnalyzing && (
        <div className="modal-backdrop" role="alert" aria-live="assertive">
          <div className="modal">
            <div className="loading-spinner" aria-hidden="true" />
            <p>Analyzing conversation...</p>
          </div>
        </div>
      )}
    </section>
  );
}
