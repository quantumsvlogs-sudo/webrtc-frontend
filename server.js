import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import express from 'express';
import { WebSocketServer } from 'ws';

process.on('uncaughtException', (err) => {
  console.error('Caught uncaughtException:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Caught unhandledRejection:', reason);
});

const dev = process.env.NODE_ENV !== 'production';
// the port MUST be 3000
const port = process.env.PORT || 3000;

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const expressApp = express();
  const server = createServer(expressApp);
  
  // Set up WebSocket server independently to avoid conflicts with HMR
  const wss = new WebSocketServer({ noServer: true });
  
  wss.on('error', (err) => console.error('WebSocket server error:', err));
  
  // A simple structured registry: roomId -> { clients: Set<ws>, offerer: ws|null, answerer: ws|null }
  const rooms = new Map();

  wss.on('connection', (ws) => {
    ws.on('error', (err) => console.error('WebSocket connection error:', err));

    let currentRoom = null;
    let currentUser = null;

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        // Handle join room
        if (data.type === 'join') {
          currentRoom = data.room;
          currentUser = data.user;
          
          if (!rooms.has(currentRoom)) {
            rooms.set(currentRoom, {
              clients: new Set(),
              offerer: null,
              answerer: null
            });
          }
          const room = rooms.get(currentRoom);

          if (room.clients.size >= 2) {
            ws.send(JSON.stringify({ type: 'server_error', message: 'Room is full' }));
            ws.close();
            return;
          }

          room.clients.add(ws);
          
          if (!room.offerer) {
            room.offerer = ws;
            ws.send(JSON.stringify({ type: 'role_assigned', role: 'offerer' }));
          } else {
            room.answerer = ws;
            ws.send(JSON.stringify({ type: 'role_assigned', role: 'answerer' }));
            
            // Both are here, tell offerer to start signaling
            room.offerer.send(JSON.stringify({ type: 'peer_joined', action: 'create_offer' }));
          }
          return;
        }

        // Forward signaling messages to other peers in the room
        if (currentRoom && rooms.has(currentRoom)) {
          const room = rooms.get(currentRoom);
          room.clients.forEach(client => {
            if (client !== ws && client.readyState === 1) { // 1 = OPEN
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        console.error('WS Error:', err);
      }
    });

    ws.on('close', () => {
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        room.clients.delete(ws);
        
        if (room.offerer === ws) room.offerer = null;
        if (room.answerer === ws) room.answerer = null;
        
        // Notify others
        room.clients.forEach(client => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'peer_left', user: currentUser }));
          }
        });
        
        if (room.clients.size === 0) {
          rooms.delete(currentRoom);
        }
      }
    });
  });

  // Next.js request handling for everything else
  expressApp.all(/.*/, (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Intercept WebSocket upgrades explicitly
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url || '/', true);

    // Skip Next.js HMR or any internal paths
    if (pathname && pathname.startsWith('/_next')) {
      return; 
    }

    // Manually pass to our signaling websocket server
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
