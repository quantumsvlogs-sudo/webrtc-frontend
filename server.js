const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, []);
  }
  return rooms.get(roomId);
}

function broadcast(room, sender, data) {
  room.forEach((client) => {
    if (client.ws !== sender && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentUser = null;

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "join") {
        currentRoom = data.room;
        currentUser = data.user;

        const room = getRoom(currentRoom);

        if (room.length >= 2) {
          ws.send(
            JSON.stringify({
              type: "server_error",
              message: "Room full",
            })
          );
          return;
        }

        room.push({
          ws,
          user: currentUser,
        });

        if (room.length === 1) {
          ws.send(
            JSON.stringify({
              type: "role_assigned",
              role: "offerer",
            })
          );
        }

        if (room.length === 2) {
          room[1].ws.send(
            JSON.stringify({
              type: "role_assigned",
              role: "answerer",
            })
          );

          room[0].ws.send(
            JSON.stringify({
              type: "peer_joined",
              action: "create_offer",
            })
          );
        }

        return;
      }

      if (data.type === "offer") {
        const room = getRoom(currentRoom);

        broadcast(room, ws, {
          type: "offer",
          offer: data.offer,
        });

        return;
      }

      if (data.type === "answer") {
        const room = getRoom(currentRoom);

        broadcast(room, ws, {
          type: "answer",
          answer: data.answer,
        });

        return;
      }

      if (data.type === "candidate") {
        const room = getRoom(currentRoom);

        broadcast(room, ws, {
          type: "candidate",
          candidate: data.candidate,
        });

        return;
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", () => {
    if (!currentRoom) return;

    const room = getRoom(currentRoom);
    const updated = room.filter((client) => client.ws !== ws);

    if (updated.length === 0) {
      rooms.delete(currentRoom);
    } else {
      rooms.set(currentRoom, updated);

      updated.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            JSON.stringify({
              type: "peer_left",
            })
          );
        }
      });
    }
  });
});

console.log("WebRTC signaling server running on port", PORT);
