"use client";

import React, { useEffect, useState, useRef } from "react";
import {
  Video,
  Mic,
  MicOff,
  VideoOff,
  Activity,
  ShieldAlert,
  Zap,
  RefreshCcw,
} from "lucide-react";

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },

  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },

  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },

  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

type AppState =
  | "IDLE"
  | "GETTING_MEDIA"
  | "CONNECTING_SIGNALING"
  | "WAITING_FOR_PEER"
  | "NEGOTIATING"
  | "CONNECTED"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "ERROR";

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const [appState, setAppState] = useState<AppState>("IDLE");

  const [micEnabled, setMicEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      pcRef.current?.close();
    };
  }, []);

  const getMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },

        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      return stream;
    } catch (err: any) {
      console.error("MEDIA ERROR:", err);

      alert("Failed to access camera/mic");

      return null;
    }
  };

  const joinRoom = async () => {
    if (!roomId.trim()) return;

    console.log("========== JOIN ROOM ==========");

    setAppState("GETTING_MEDIA");

    const stream = await getMedia();

    if (!stream) {
      setAppState("ERROR");
      return;
    }

    setAppState("CONNECTING_SIGNALING");

    // cleanup old
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    const pendingCandidates: RTCIceCandidateInit[] = [];

    let isOfferer = false;

    const wsUrl = process.env.NEXT_PUBLIC_WS_URL as string;

    console.log("WS URL:", wsUrl);

    const ws = new WebSocket(wsUrl);

    wsRef.current = ws;

    const createPC = () => {
      if (pcRef.current) return pcRef.current;

      console.log("CREATING PEER CONNECTION");

      const pc = new RTCPeerConnection({
        iceServers,
      });

      localStreamRef.current?.getTracks().forEach((track) => {
        console.log("ADDING TRACK:", track.kind);

        pc.addTrack(track, localStreamRef.current!);
      });

      pc.ontrack = (event) => {
        console.log("REMOTE TRACK RECEIVED");

        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }

        setAppState("CONNECTED");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("SENDING ICE");

          ws.send(
            JSON.stringify({
              type: "candidate",
              candidate: event.candidate,
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("PC STATE:", pc.connectionState);

        if (pc.connectionState === "connected") {
          setAppState("CONNECTED");
        }

        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        ) {
          console.log("CONNECTION FAILED");
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("ICE STATE:", pc.iceConnectionState);
      };

      pcRef.current = pc;

      return pc;
    };

    ws.onopen = () => {
      console.log("WS OPEN");

      setAppState("WAITING_FOR_PEER");

      ws.send(
        JSON.stringify({
          type: "join",
          room: roomId,
          user: Math.random().toString(36).slice(2),
        })
      );
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      console.log("WS MESSAGE:", data);

      try {
        // ROLE
        if (data.type === "role_assigned") {
          console.log("ROLE:", data.role);

          isOfferer = data.role === "offerer";

          createPC();

          return;
        }

        // PEER JOINED
        if (data.type === "peer_joined") {
          console.log("PEER JOINED");

          // ONLY offerer creates offer
          if (!isOfferer) {
            console.log("WAITING FOR OFFER");
            return;
          }

          const pc = createPC();

          setAppState("NEGOTIATING");

          const offer = await pc.createOffer();

          console.log("CREATED OFFER");

          await pc.setLocalDescription(offer);

          ws.send(
            JSON.stringify({
              type: "offer",
              offer,
            })
          );

          return;
        }

        // OFFER
        if (data.type === "offer") {
          console.log("RECEIVED OFFER");

          const pc = createPC();

          setAppState("NEGOTIATING");

          await pc.setRemoteDescription(
            new RTCSessionDescription(data.offer)
          );

          console.log("REMOTE DESCRIPTION SET");

          const answer = await pc.createAnswer();

          console.log("CREATED ANSWER");

          await pc.setLocalDescription(answer);

          ws.send(
            JSON.stringify({
              type: "answer",
              answer,
            })
          );

          while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();

            if (candidate) {
              await pc.addIceCandidate(
                new RTCIceCandidate(candidate)
              );
            }
          }

          return;
        }

        // ANSWER
        if (data.type === "answer") {
          console.log("RECEIVED ANSWER");

          const pc = pcRef.current;

          if (!pc) {
            console.log("NO PC FOR ANSWER");
            return;
          }

          await pc.setRemoteDescription(
            new RTCSessionDescription(data.answer)
          );

          console.log("ANSWER APPLIED");

          while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();

            if (candidate) {
              await pc.addIceCandidate(
                new RTCIceCandidate(candidate)
              );
            }
          }

          return;
        }

        // ICE
        if (data.type === "candidate") {
          console.log("RECEIVED ICE");

          const pc = pcRef.current;

          if (!pc) {
            console.log("NO PC YET, QUEUE ICE");

            pendingCandidates.push(data.candidate);

            return;
          }

          if (!pc.remoteDescription) {
            console.log("NO REMOTE DESCRIPTION YET, QUEUE ICE");

            pendingCandidates.push(data.candidate);

            return;
          }

          await pc.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );

          console.log("ICE ADDED");

          return;
        }

        // PEER LEFT
        if (data.type === "peer_left") {
          console.log("PEER LEFT");

          setAppState("WAITING_FOR_PEER");

          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }

          if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
          }

          return;
        }

        // SERVER ERROR
        if (data.type === "server_error") {
          console.log("SERVER ERROR:", data.message);

          alert(data.message);

          setAppState("ERROR");

          return;
        }
      } catch (err) {
        console.error("MESSAGE HANDLER ERROR:", err);
      }
    };

    ws.onerror = (err) => {
      console.error("WS ERROR:", err);

      setAppState("ERROR");
    };

    ws.onclose = () => {
      console.log("WS CLOSED");
    };
  };

  const leaveCall = () => {
    setAppState("DISCONNECTED");

    wsRef.current?.close();

    pcRef.current?.close();

    localStreamRef.current?.getTracks().forEach((t) => t.stop());

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    wsRef.current = null;
    pcRef.current = null;
  };

  const toggleMic = () => {
    const track = localStreamRef.current
      ?.getAudioTracks?.()[0];

    if (!track) return;

    track.enabled = !track.enabled;

    setMicEnabled(track.enabled);
  };

  const toggleVideo = () => {
    const track = localStreamRef.current
      ?.getVideoTracks?.()[0];

    if (!track) return;

    track.enabled = !track.enabled;

    setVideoEnabled(track.enabled);
  };

  return (
    <main className="min-h-screen bg-[#050510] text-[#e0e0e0] font-mono flex flex-col items-center">
      <header className="w-full max-w-5xl py-8 px-6 text-center">
        <h1 className="text-3xl md:text-5xl font-bold tracking-[0.3em] uppercase text-[#00d4ff] flex items-center justify-center gap-4">
          <Zap size={36} />
          DirectLink
        </h1>

        <p className="mt-4 text-xs md:text-sm tracking-widest text-[#a0a0ff] opacity-80 uppercase flex flex-wrap justify-center items-center gap-2">
          <span>Zero Server Storage</span>

          <span className="opacity-50">•</span>

          <span>Pure WebRTC</span>

          <span className="opacity-50">•</span>

          <span>End-to-End P2P</span>
        </p>
      </header>

      <div className="w-full max-w-5xl px-4 flex-1 flex flex-col">
        {appState === "IDLE" ||
        appState === "DISCONNECTED" ? (
          <div className="flex-1 flex flex-col items-center justify-center border border-[#00d4ff]/20 bg-[#00d4ff]/5 p-8 rounded-2xl backdrop-blur-md max-w-xl mx-auto w-full">
            <ShieldAlert
              size={48}
              className="text-[#00d4ff] mb-6 opacity-80"
            />

            <h2 className="text-xl tracking-widest uppercase mb-8 text-[#00d4ff] font-bold">
              Initialize Secure Channel
            </h2>

            <div className="w-full max-w-sm space-y-4">
              <input
                type="text"
                value={roomId}
                onChange={(e) =>
                  setRoomId(e.target.value.toUpperCase())
                }
                placeholder="ENTER ROOM CODE..."
                className="w-full bg-black/60 border border-[#00d4ff]/50 rounded-lg p-4 text-[#00d4ff] placeholder-[#00d4ff]/40 text-center text-lg tracking-widest focus:outline-none uppercase"
                maxLength={12}
              />

              <button
                onClick={joinRoom}
                disabled={!roomId.trim()}
                className="w-full bg-[#00d4ff]/20 border border-[#00d4ff] text-[#00d4ff] font-bold tracking-widest uppercase p-4 rounded-lg hover:bg-[#00d4ff] hover:text-black transition-all disabled:opacity-50"
              >
                Connect to Peer
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-4">
            <div className="bg-black/40 border border-gray-800 rounded-lg p-3 flex flex-wrap items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full animate-pulse",
                    appState === "CONNECTED"
                      ? "bg-green-500"
                      : appState === "ERROR"
                      ? "bg-red-500"
                      : "bg-yellow-500"
                  )}
                />

                <span className="text-xs tracking-widest uppercase font-bold">
                  {appState.replace(/_/g, " ")}
                </span>

                {appState === "RECONNECTING" && (
                  <RefreshCcw
                    size={12}
                    className="animate-spin"
                  />
                )}
              </div>

              <div className="flex items-center gap-3 mt-2 sm:mt-0 font-mono text-xs tracking-wider">
                <span className="text-gray-500">ROOM:</span>

                <span className="text-[#00d4ff] bg-[#00d4ff]/10 px-2 py-1 rounded border border-[#00d4ff]/30">
                  {roomId}
                </span>
              </div>
            </div>

            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-fr">
              {/* LOCAL */}
              <div className="relative bg-[#080816] rounded-xl overflow-hidden border border-gray-800 flex items-center justify-center">
                <div className="absolute top-4 left-4 z-10 bg-black/60 text-xs tracking-wider uppercase px-3 py-1 rounded border border-gray-700 text-gray-300">
                  You
                </div>

                {!videoEnabled && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-0">
                    <VideoOff
                      size={48}
                      className="text-gray-600"
                    />
                  </div>
                )}

                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={cn(
                    "w-full h-full object-cover transition-opacity duration-300",
                    videoEnabled
                      ? "opacity-100"
                      : "opacity-0"
                  )}
                />
              </div>

              {/* REMOTE */}
              <div className="relative bg-[#080816] rounded-xl overflow-hidden border border-[#00d4ff]/30 flex items-center justify-center">
                <div className="absolute top-4 left-4 z-10 bg-[#00d4ff]/10 text-xs tracking-wider uppercase px-3 py-1 rounded border border-[#00d4ff]/30 text-[#00d4ff]">
                  Remote Node
                </div>

                {!remoteVideoRef.current?.srcObject && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 gap-4">
                    <Activity
                      size={32}
                      className="opacity-50 animate-pulse"
                    />

                    <span className="text-xs uppercase tracking-widest opacity-50">
                      Waiting for feed...
                    </span>
                  </div>
                )}

                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />
              </div>
            </div>

            {/* CONTROLS */}
            <div className="bg-black/60 border border-gray-800 rounded-xl p-4 flex justify-center gap-6">
              <button
                onClick={toggleMic}
                className={cn(
                  "p-4 rounded-full transition-all border",
                  micEnabled
                    ? "bg-gray-800 border-gray-600 text-white"
                    : "bg-red-500/20 border-red-500 text-red-500"
                )}
              >
                {micEnabled ? (
                  <Mic size={24} />
                ) : (
                  <MicOff size={24} />
                )}
              </button>

              <button
                onClick={toggleVideo}
                className={cn(
                  "p-4 rounded-full transition-all border",
                  videoEnabled
                    ? "bg-gray-800 border-gray-600 text-white"
                    : "bg-red-500/20 border-red-500 text-red-500"
                )}
              >
                {videoEnabled ? (
                  <Video size={24} />
                ) : (
                  <VideoOff size={24} />
                )}
              </button>

              <div className="w-px bg-gray-700 mx-2"></div>

              <button
                onClick={leaveCall}
                className="px-6 py-4 rounded-full bg-red-600 hover:bg-red-500 text-white font-bold tracking-widest uppercase transition-colors"
              >
                End
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
