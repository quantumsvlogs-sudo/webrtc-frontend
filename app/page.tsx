"use client";

import React, { useEffect, useState, useRef } from 'react';
import { Video, Mic, MicOff, VideoOff, Activity, ShieldAlert, Zap, RefreshCcw } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// STUN servers + TURN fallback
const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

type AppState = 
  | 'IDLE'
  | 'GETTING_MEDIA'
  | 'CONNECTING_SIGNALING'
  | 'WAITING_FOR_PEER'
  | 'NEGOTIATING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'ERROR';

export default function Home() {
  const [roomId, setRoomId] = useState('');
  const [appState, setAppState] = useState<AppState>('IDLE');
  const [micEnabled, setMicEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (pcRef.current) pcRef.current.close();
    };
  }, []);

  const getMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      return stream;
    } catch (err: any) {
      console.error("Camera error:", err);
      alert("Failed to access camera/mic: " + err.message);
      return null;
    }
  };

  const createPeerConnection = () => {
    if (pcRef.current) {
      pcRef.current.close();
    }
    
    const pc = new RTCPeerConnection({ iceServers });
    
    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    pc.ontrack = (event) => {
      setAppState('CONNECTED');
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'candidate',
          candidate: event.candidate
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection State:", pc.connectionState);
      if (pc.connectionState === 'connected') {
        setAppState('CONNECTED');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setAppState('RECONNECTING');
        handleReconnect();
      } else if (pc.connectionState === 'connecting') {
        setAppState('NEGOTIATING');
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      console.log("ICE State:", pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        pc.restartIce(); // Try to restart ICE if it fully fails
      }
    };

    pcRef.current = pc;
    return pc;
  };

  const handleReconnect = () => {
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    reconnectTimeoutRef.current = setTimeout(() => {
      // Re-initiate connection if we still have WS
      if (wsRef.current?.readyState === WebSocket.OPEN && appState !== 'DISCONNECTED') {
        setAppState('RECONNECTING');
        initiateCall();
      }
    }, 2000);
  };

  const initiateCall = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'offer',
          offer
        }));
      }
    } catch (err) {
      console.error("Error creating offer", err);
    }
  };

  const joinRoom = async () => {
    if (!roomId.trim()) return;
    
    setAppState('GETTING_MEDIA');
    const stream = await getMedia();
    if (!stream) {
      setAppState('ERROR');
      return;
    }

    setAppState('CONNECTING_SIGNALING');

    const ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL as string);
    wsRef.current = ws;

    ws.onopen = () => {
      setAppState('WAITING_FOR_PEER');
      const userId = Math.random().toString(36).substring(7);
      ws.send(JSON.stringify({ type: 'join', room: roomId, user: userId }));
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      console.log('WS msg:', data.type);

      if (!pcRef.current && data.type !== 'join' && data.type !== 'role_assigned') {
        createPeerConnection();
      }

      const pc = pcRef.current;

      if (data.type === 'role_assigned') {
        console.log('Assigned role:', data.role);
        if (data.role === 'offerer') {
          createPeerConnection();
        } else if (data.role === 'answerer') {
          createPeerConnection();
        }
      }
      else if (data.type === 'peer_joined' && data.action === 'create_offer') {
        setAppState('NEGOTIATING');
        initiateCall();
      }
      else if (data.type === 'offer' && pc) {
        setAppState('NEGOTIATING');
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        ws.send(JSON.stringify({
          type: 'answer',
          answer
        }));
      }
      else if (data.type === 'answer' && pc) {
        setAppState('NEGOTIATING');
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
      else if (data.type === 'candidate' && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(err => {
          console.error("Error adding Ice", err);
        });
      }
      else if (data.type === 'peer_left') {
        setAppState('WAITING_FOR_PEER');
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (pcRef.current) pcRef.current.close();
        pcRef.current = null;
      }
      else if (data.type === 'server_error') {
        alert(data.message);
        setAppState('DISCONNECTED');
        ws.close();
      }
    };

    ws.onerror = (err) => {
      setAppState('ERROR');
      console.error("WS error:", err);
    };

    ws.onclose = () => {
      if (appState !== 'DISCONNECTED') {
        setAppState('DISCONNECTED');
      }
    };
  };

  const leaveCall = () => {
    setAppState('DISCONNECTED');
    if (wsRef.current) wsRef.current.close();
    if (pcRef.current) pcRef.current.close();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    pcRef.current = null;
    wsRef.current = null;
  };

  const toggleMic = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getAudioTracks()[0];
      if (track) { 
        track.enabled = !track.enabled; 
        setMicEnabled(track.enabled); 
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getVideoTracks()[0];
      if (track) { 
        track.enabled = !track.enabled; 
        setVideoEnabled(track.enabled); 
      }
    }
  };

  return (
    <main className="min-h-screen bg-[#050510] text-[#e0e0e0] font-mono flex flex-col items-center">
      <header className="w-full max-w-5xl py-8 px-6 text-center">
        <h1 className="text-3xl md:text-5xl font-bold tracking-[0.3em] uppercase text-[#00d4ff] neon-text-blue flex items-center justify-center gap-4">
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
        {appState === 'IDLE' || appState === 'DISCONNECTED' ? (
          <div className="flex-1 flex flex-col items-center justify-center border border-[#00d4ff]/20 bg-[#00d4ff]/5 p-8 rounded-2xl neon-border-blue relative overflow-hidden backdrop-blur-md max-w-xl mx-auto w-full">
            <div className="absolute inset-0 bg-gradient-to-b from-[#00d4ff]/10 to-transparent pointer-events-none" />
            
            <ShieldAlert size={48} className="text-[#00d4ff] mb-6 opacity-80" />
            
            <h2 className="text-xl tracking-widest uppercase mb-8 text-[#00d4ff] font-bold">Initialize Secure Channel</h2>
            
            <div className="w-full max-w-sm space-y-4">
              <input
                type="text"
                value={roomId}
                onChange={e => setRoomId(e.target.value.toUpperCase())}
                placeholder="ENTER ROOM CODE..."
                className="w-full bg-black/60 border border-[#00d4ff]/50 rounded-lg p-4 text-[#00d4ff] placeholder-[#00d4ff]/40 text-center text-lg tracking-widest focus:outline-none focus:border-[#00d4ff] uppercase transition-colors"
                maxLength={12}
              />
              
              <button
                onClick={joinRoom}
                disabled={!roomId.trim()}
                className="w-full bg-[#00d4ff]/20 border border-[#00d4ff] text-[#00d4ff] font-bold tracking-widest uppercase p-4 rounded-lg hover:bg-[#00d4ff] hover:text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(0,212,255,0.2)] hover:shadow-[0_0_20px_rgba(0,212,255,0.6)]"
              >
                Connect to Peer
              </button>
            </div>
            
            <p className="mt-8 text-[10px] uppercase tracking-wider text-gray-500 text-center max-w-xs">
              Connections are established directly between devices. No media servers are used.
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-4">
            
            {/* Status Bar */}
            <div className="bg-black/40 border border-gray-800 rounded-lg p-3 flex flex-wrap items-center justify-between z-10 shadow-lg">
              <div className="flex items-center gap-3">
                <span className={cn(
                  "h-2 w-2 rounded-full animate-pulse",
                  appState === 'CONNECTED' ? "bg-green-500 shadow-[0_0_10px_green]" : 
                  appState === 'ERROR' ? "bg-red-500 shadow-[0_0_10px_red]" : 
                  "bg-yellow-500 shadow-[0_0_10px_yellow]"
                )} />
                <span className={cn(
                  "text-xs tracking-widest uppercase font-bold",
                  appState === 'CONNECTED' ? "text-green-400" :
                  appState === 'ERROR' ? "text-red-400" :
                  "text-yellow-400"
                )}>
                  {appState.replace(/_/g, ' ')}
                </span>
                {appState === 'RECONNECTING' && <RefreshCcw size={12} className="animate-spin text-yellow-500 ml-1" />}
              </div>
              <div className="flex items-center gap-3 mt-2 sm:mt-0 font-mono text-xs tracking-wider">
                <span className="text-gray-500">ROOM:</span>
                <span className="text-[#00d4ff] bg-[#00d4ff]/10 px-2 py-1 rounded border border-[#00d4ff]/30">{roomId}</span>
              </div>
            </div>

            {/* Video Grids */}
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-fr">
              {/* Local Video */}
              <div className="relative bg-[#080816] rounded-xl overflow-hidden border border-gray-800 flex items-center justify-center">
                <div className="absolute top-4 left-4 z-10 bg-black/60 backdrop-blur text-xs tracking-wider uppercase px-3 py-1 rounded border border-gray-700 text-gray-300">
                  You
                </div>
                {!videoEnabled && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-0">
                    <VideoOff size={48} className="text-gray-600" />
                  </div>
                )}
                <video 
                  ref={localVideoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className={cn(
                    "w-full h-full object-cover transition-opacity duration-300",
                    videoEnabled ? "opacity-100" : "opacity-0"
                  )} 
                />
              </div>

              {/* Remote Video */}
              <div className="relative bg-[#080816] rounded-xl overflow-hidden border border-[#00d4ff]/30 flex items-center justify-center neon-border-blue">
                <div className="absolute top-4 left-4 z-10 bg-[#00d4ff]/10 backdrop-blur text-xs tracking-wider uppercase px-3 py-1 rounded border border-[#00d4ff]/30 text-[#00d4ff]">
                  Remote Node
                </div>
                {!remoteVideoRef.current?.srcObject && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 gap-4">
                    <Activity size={32} className="opacity-50 animate-pulse" />
                    <span className="text-xs uppercase tracking-widest opacity-50">Waiting for feed...</span>
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

            {/* Controls */}
            <div className="bg-black/60 border border-gray-800 rounded-xl p-4 flex justify-center gap-6 z-10 backdrop-blur-lg">
              <button 
                onClick={toggleMic}
                className={cn(
                  "p-4 rounded-full transition-all border",
                  micEnabled ? "bg-gray-800 hover:bg-gray-700 border-gray-600 text-white" : "bg-red-500/20 border-red-500 text-red-500 hover:bg-red-500/40"
                )}
              >
                {micEnabled ? <Mic size={24} /> : <MicOff size={24} />}
              </button>
              
              <button 
                onClick={toggleVideo}
                className={cn(
                  "p-4 rounded-full transition-all border",
                  videoEnabled ? "bg-gray-800 hover:bg-gray-700 border-gray-600 text-white" : "bg-red-500/20 border-red-500 text-red-500 hover:bg-red-500/40"
                )}
              >
                {videoEnabled ? <Video size={24} /> : <VideoOff size={24} />}
              </button>

              <div className="w-px bg-gray-700 mx-2"></div>

              <button 
                onClick={leaveCall}
                className="px-6 py-4 rounded-full bg-red-600 hover:bg-red-500 text-white font-bold tracking-widest uppercase transition-colors shadow-[0_0_15px_rgba(220,38,38,0.5)]"
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
