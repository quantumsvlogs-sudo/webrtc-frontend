import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new Server(server);
  
  // Real-time signaling logic
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Join a global room for this simple app
    socket.join('global');

    // WebRTC Signaling
    socket.on('join-room', (roomId, userId) => {
      socket.join(roomId);
      socket.to(roomId).emit('user-connected', userId);
    });

    socket.on('offer', (targetId, offer) => {
      socket.to(targetId).emit('offer', socket.id, offer);
    });

    socket.on('answer', (targetId, answer) => {
      socket.to(targetId).emit('answer', socket.id, answer);
    });

    socket.on('ice-candidate', (targetId, candidate) => {
      socket.to(targetId).emit('ice-candidate', socket.id, candidate);
    });

    // Chat
    socket.on('chat-message', (data) => {
      io.to('global').emit('chat-message', { ...data, senderId: socket.id, timestamp: Date.now() });
    });

    // Call UI State Sync
    socket.on('call-state-change', (data) => {
      socket.to('global').emit('call-state-change', { ...data, senderId: socket.id });
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      io.to('global').emit('user-disconnected', socket.id);
    });
  });

  // Let Next.js handle graceful shutdowns
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
      process.exit(0);
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
