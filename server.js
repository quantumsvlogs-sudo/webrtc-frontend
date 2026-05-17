const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const SERVER_VERSION = "2026-05-17-b";

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
    if (
      client.ws !== sender &&
      client.ws.readyState === WebSocket.OPEN
    ) {
      client.ws.send(JSON.stringify(payload));
    }
  });
}

function assignRolesAndStart(roomId) {
  const room = getRoom(roomId);

  // FIRST USER
  if (room.length === 1) {
    sendJSON(room[0].ws, {
      type: "role-assigned",
      role: "offerer",
      serverVersion: SERVER_VERSION,
    });

    sendJSON(room[0].ws, {
      type: "waiting-for-peer",
      serverVersion: SERVER_VERSION,
    });

    console.log(
      `[${SERVER_VERSION}] waiting for peer room=${roomId}`
    );

    return;
  }

  // SECOND USER
  if (room.length === 2) {
    const offerer = room[0];
    const answerer = room[1];

    sendJSON(offerer.ws, {
      type: "role-assigned",
      role: "offerer",
      serverVersion: SERVER_VERSION,
    });

    sendJSON(answerer.ws, {
      type: "role-assigned",
      role: "answerer",
      serverVersion: SERVER_VERSION,
    });

    sendJSON(offerer.ws, {
      type: "peer-joined",
      action: "create-offer",
      serverVersion: SERVER_VERSION,
    });

    sendJSON(answerer.ws, {
      type: "peer-joined",
      action: "wait-for-offer",
      serverVersion: SERVER_VERSION,
    });

    console.log(
      `[${SERVER_VERSION}] peer pair complete room=${roomId}`
    );

    return;
  }
}

wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentUser = null;

  console.log(
    `[${SERVER_VERSION}] websocket connected`
  );

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      // JOIN
      if (data.type === "join") {
        const roomId = String(data.room || "")
          .trim()
          .toUpperCase();

        const userId = String(data.user || "").trim();

        if (!roomId) {
          sendJSON(ws, {
            type: "server-error",
            message: "Missing room id",
            serverVersion: SERVER_VERSION,
          });

          return;
        }

        removeSocketFromAllRooms(ws);

        currentRoom = roomId;
        currentUser = userId;

        const room = getRoom(currentRoom);

        if (room.length >= 2) {
          sendJSON(ws, {
            type: "server-error",
            message: "Room full",
            serverVersion: SERVER_VERSION,
          });

          return;
        }

        room.push({
          ws,
          user: currentUser,
          joinedAt: Date.now(),
        });

        console.log(
          `[${SERVER_VERSION}] joined room=${currentRoom} user=${currentUser} size=${room.length}`
        );

        assignRolesAndStart(currentRoom);

        return;
      }

      // MUST JOIN FIRST
      if (!currentRoom) {
        sendJSON(ws, {
          type: "server-error",
          message: "Join a room first",
          serverVersion: SERVER_VERSION,
        });

        return;
      }

      // OFFER
      if (data.type === "offer") {
        console.log(
          `[${SERVER_VERSION}] relaying offer room=${currentRoom}`
        );

        broadcastToRoom(currentRoom, ws, {
          type: "offer",
          offer: data.offer,
          serverVersion: SERVER_VERSION,
        });

        return;
      }

      // ANSWER
      if (data.type === "answer") {
        console.log(
          `[${SERVER_VERSION}] relaying answer room=${currentRoom}`
        );

        broadcastToRoom(currentRoom, ws, {
          type: "answer",
          answer: data.answer,
          serverVersion: SERVER_VERSION,
        });

        return;
      }

      // ICE CANDIDATE
      if (data.type === "candidate") {
        broadcastToRoom(currentRoom, ws, {
          type: "candidate",
          candidate: data.candidate,
          serverVersion: SERVER_VERSION,
        });

        return;
      }

      // PING
      if (data.type === "ping") {
        sendJSON(ws, {
          type: "pong",
          serverVersion: SERVER_VERSION,
        });

        return;
      }

      console.log(
        `[${SERVER_VERSION}] unknown message type=${data.type}`
      );
    } catch (err) {
      console.error(
        `[${SERVER_VERSION}] message error:`,
        err
      );

      sendJSON(ws, {
        type: "server-error",
        message: "Bad message",
        serverVersion: SERVER_VERSION,
      });
    }
  });

  ws.on("close", () => {
    console.log(
      `[${SERVER_VERSION}] websocket disconnected`
    );

    if (!currentRoom) {
      return;
    }

    const room = getRoom(currentRoom);

    const updated = room.filter(
      (client) => client.ws !== ws
    );

    if (updated.length === 0) {
      rooms.delete(currentRoom);

      console.log(
        `[${SERVER_VERSION}] deleted room=${currentRoom}`
      );
    } else {
      rooms.set(currentRoom, updated);

      console.log(
        `[${SERVER_VERSION}] peer left room=${currentRoom} remaining=${updated.length}`
      );

      updated.forEach((client) => {
        sendJSON(client.ws, {
          type: "peer-left",
          serverVersion: SERVER_VERSION,
        });
      });
    }

    currentRoom = null;
    currentUser = null;
  });

  ws.on("error", (err) => {
    console.error(
      `[${SERVER_VERSION}] websocket error:`,
      err
    );
  });
});

wss.on("listening", () => {
  console.log(
    `WebRTC signaling server running on port ${PORT}`
  );

  console.log(
    `Server version: ${SERVER_VERSION}`
  );
});
