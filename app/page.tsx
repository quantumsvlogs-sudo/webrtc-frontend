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

  // cleanup old sockets
  if (wsRef.current) {
    wsRef.current.close();
    wsRef.current = null;
  }

  if (pcRef.current) {
    pcRef.current.close();
    pcRef.current = null;
  }

  const pendingCandidates: RTCIceCandidateInit[] = [];

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

        createPC();

        return;
      }

      // PEER JOINED -> CREATE OFFER
      if (data.type === "peer_joined") {
        console.log("PEER JOINED");

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

        // flush queued ICE
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
