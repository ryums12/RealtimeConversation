import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  const [scenario, setScenario] = useState(
    "You are a friendly English conversation partner. Keep replies short and ask one question at a time."
  );
  const [status, setStatus] = useState("Idle");
  const [isRunning, setIsRunning] = useState(false);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

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

      // The AI's spoken response arrives as a remote audio track.
      peerConnection.ontrack = (event) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = event.streams[0];
        }
      };

      localStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      // The data channel is not used for UI here, but creating it enables realtime events.
      peerConnection.createDataChannel("oai-events");

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      setStatus("Negotiating secure session...");
      const response = await fetch("/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sdp: offer.sdp,
          scenario,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
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
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    // Clear remote audio playback.
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

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

        <div className="controls">
          <button onClick={startConversation} disabled={isRunning}>
            Start Conversation
          </button>
          <button onClick={stopConversation}>Stop / Reset</button>
        </div>

        <p className="status">Status: {status}</p>
      </section>

      <audio ref={remoteAudioRef} autoPlay playsInline />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
