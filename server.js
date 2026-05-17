const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const SERVER_VERSION = "2026-05-17-a";

const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, []);
  }
  return rooms.get(roomId);
}

function removeSocketFromAllRooms(ws) {
  for (const [roomId, room] of rooms.entries()) {
    const filtered = room.filter((client) => client.ws !== ws);

    if (filtered.length === 0) {
      rooms.delete(roomId);
    } else if (filtered.length !== room.length) {
      rooms.set(roomId, filtered);
    }
  }
}

function sendJSON(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(roomId, sender, payload) {
  const room = getRoom(roomId);

  room.forEach((client) => {
    if (client.ws !== sender && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload));
    }
  });
}

function assignRolesAndStart(roomId) {
  const room = getRoom(roomId);

  if (room.length === 1) {
    sendJSON(room[0].ws, {
      type: "role_assigned",
      role: "offerer",
      server_version: SERVER_VERSION,
    });

    sendJSON(room[0].ws, {
      type: "waiting_for_peer",
      server_version: SERVER_VERSION,
    });

    return;
  }

  if (room.length === 2) {
    const offerer = room[0];
    const answerer = room[1];

    sendJSON(answerer.ws, {
      type: "role_assigned",
      role: "answerer",
      server_version: SERVER_VERSION,
    });

    sendJSON(offerer.ws, {
      type: "role_assigned",
      role: "offerer",
      server_version: SERVER_VERSION,
    });

    sendJSON(offerer.ws, {
      type: "peer_joined",
      action: "create_offer",
      server_version: SERVER_VERSION,
    });

    sendJSON(answerer.ws, {
      type: "peer_joined",
      action: "ready_to_answer",
      server_version: SERVER_VERSION,
    });

    return;
  }
}

wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentUser = null;

  console.log(`[${SERVER_VERSION}] websocket connected`);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "join") {
        const roomId = String(data.room || "").trim();
        const userId = String(data.user || "").trim();

        if (!roomId) {
          sendJSON(ws, {
            type: "server_error",
            message: "Missing room id",
            server_version: SERVER_VERSION,
          });
          return;
        }

        removeSocketFromAllRooms(ws);

        currentRoom = roomId;
        currentUser = userId;

        const room = getRoom(currentRoom);

        if (room.length >= 2) {
          sendJSON(ws, {
            type: "server_error",
            message: "Room full",
            server_version: SERVER_VERSION,
          });
          return;
        }

        room.push({
          ws,
          user: currentUser,
          joinedAt: Date.now(),
        });

        console.log(
          `[${SERVER_VERSION}] user joined room=${currentRoom} user=${currentUser} size=${room.length}`
        );

        assignRolesAndStart(currentRoom);
        return;
      }

      if (!currentRoom) {
        sendJSON(ws, {
          type: "server_error",
          message: "Not joined to a room yet",
          server_version: SERVER_VERSION,
        });
        return;
      }

      if (data.type === "offer") {
        console.log(`[${SERVER_VERSION}] offer relayed room=${currentRoom}`);
        broadcastToRoom(currentRoom, ws, {
          type: "offer",
          offer: data.offer,
          server_version: SERVER_VERSION,
        });
        return;
      }

      if (data.type === "answer") {
        console.log(`[${SERVER_VERSION}] answer relayed room=${currentRoom}`);
        broadcastToRoom(currentRoom, ws, {
          type: "answer",
          answer: data.answer,
          server_version: SERVER_VERSION,
        });
        return;
      }

      if (data.type === "candidate") {
        broadcastToRoom(currentRoom, ws, {
          type: "candidate",
          candidate: data.candidate,
          server_version: SERVER_VERSION,
        });
        return;
      }

      if (data.type === "ping") {
        sendJSON(ws, {
          type: "pong",
          server_version: SERVER_VERSION,
        });
        return;
      }

      console.log(
        `[${SERVER_VERSION}] unknown message type=${data.type || "missing"} room=${currentRoom}`
      );
    } catch (err) {
      console.error(`[${SERVER_VERSION}] message error:`, err);
      sendJSON(ws, {
        type: "server_error",
        message: "Bad message",
        server_version: SERVER_VERSION,
      });
    }
  });

  ws.on("close", () => {
    if (!currentRoom) {
      return;
    }

    const room = getRoom(currentRoom);
    const updated = room.filter((client) => client.ws !== ws);

    if (updated.length === 0) {
      rooms.delete(currentRoom);
      console.log(`[${SERVER_VERSION}] room deleted=${currentRoom}`);
    } else {
      rooms.set(currentRoom, updated);
      console.log(
        `[${SERVER_VERSION}] peer left room=${currentRoom} remaining=${updated.length}`
      );

      updated.forEach((client) => {
        sendJSON(client.ws, {
          type: "peer_left",
          server_version: SERVER_VERSION,
        });
      });
    }

    currentRoom = null;
    currentUser = null;
  });
});

wss.on("listening", () => {
  console.log(`WebRTC signaling server running on port ${PORT}`);
  console.log(`Server version: ${SERVER_VERSION}`);
});
