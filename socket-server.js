// Socket.io server for video calling - deploy separately on Render.com
const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 10000;

const server = createServer();

// Configure CORS for production
const io = new Server(server, {
  cors: {
    origin: [
      'https://tipashluxuries.com',
      'http://localhost:3000',
      'http://localhost:3001'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Store connected users and their socket IDs
const users = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId
const rooms = new Map(); // roomId -> Set of socketIds
let adminSocket = null;

console.log('🚀 Socket.io server starting...');

io.on('connection', (socket) => {
  console.log(`📱 User connected: ${socket.id}`);

  // User registers with their ID
  socket.on('register', (data) => {
    const { userId, isAdmin } = data;
    users.set(userId, socket.id);
    socketToUser.set(socket.id, userId);
    
    if (isAdmin) {
      adminSocket = socket.id;
      console.log(`👑 Admin connected: ${socket.id}`);
    }
    
    console.log(`✅ User registered: ${userId} (isAdmin: ${isAdmin})`);
  });

  // Handle call request
  socket.on('call-request', (data) => {
    const { callerId, callerName, callType, roomId } = data;
    console.log(`📞 Call request from ${callerName} (${callerId}) - Room: ${roomId}`);
    
    // Notify admin
    if (adminSocket) {
      io.to(adminSocket).emit('incoming-call', {
        callerId,
        callerName,
        callType,
        roomId,
        socketId: socket.id
      });
    }
  });

  // Handle call acceptance
  socket.on('accept-call', (data) => {
    const { callerId, roomId } = data;
    console.log(`✅ Call accepted - Room: ${roomId}`);
    
    // Notify the caller
    const callerSocketId = users.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-accepted', {
        roomId,
        calleeSocketId: socket.id
      });
    }
  });

  // Handle call rejection
  socket.on('reject-call', (data) => {
    const { callerId, reason } = data;
    console.log(`❌ Call rejected: ${reason}`);
    
    const callerSocketId = users.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-rejected', { reason });
    }
  });

  // Handle call end
  socket.on('end-call', (data) => {
    const { roomId, userId } = data;
    console.log(`📴 Call ended - Room: ${roomId}`);
    
    // Notify all in room
    if (rooms.has(roomId)) {
      rooms.get(roomId).forEach(socketId => {
        io.to(socketId).emit('call-ended', { reason: 'Call ended by ' + userId });
      });
    }
  });

  // Join room for WebRTC
  socket.on('join-room', (data) => {
    const { roomId } = data;
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(socket.id);
    socket.join(roomId);
    
    console.log(`🚪 User ${socket.id} joined room ${roomId}`);
    
    // Notify others in room
    socket.to(roomId).emit('user-joined', { socketId: socket.id });
  });

  // Leave room
  socket.on('leave-room', (data) => {
    const { roomId } = data;
    
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(socket.id);
      socket.leave(roomId);
      console.log(`🚪 User ${socket.id} left room ${roomId}`);
      
      // Notify others in room
      socket.to(roomId).emit('user-left', { socketId: socket.id });
    }
  });

  // WebRTC Signaling: Offer
  socket.on('offer', (data) => {
    const { roomId, offer } = data;
    console.log(`📤 Offer received in room: ${roomId}`);
    
    // Broadcast offer to all other users in the room
    if (rooms.has(roomId)) {
      rooms.get(roomId).forEach((socketId) => {
        if (socketId !== socket.id) {
          io.to(socketId).emit('offer', {
            offer,
            senderSocketId: socket.id,
            roomId,
          });
        }
      });
    }
  });

  // WebRTC Signaling: Answer
  socket.on('answer', (data) => {
    const { roomId, answer, targetSocketId } = data;
    console.log(`📤 Answer received in room: ${roomId}`);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('answer', {
        answer,
        senderSocketId: socket.id,
      });
    }
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('ice-candidate', (data) => {
    const { roomId, candidate } = data;
    
    // Broadcast to all in room except sender
    if (rooms.has(roomId)) {
      rooms.get(roomId).forEach((socketId) => {
        if (socketId !== socket.id) {
          io.to(socketId).emit('ice-candidate', {
            candidate,
            senderSocketId: socket.id,
          });
        }
      });
    }
  });

  // ICE candidate to room (for broadcasting)
  socket.on('ice-candidate-to-room', (data) => {
    const { roomId, candidate } = data;
    
    if (rooms.has(roomId)) {
      rooms.get(roomId).forEach((socketId) => {
        if (socketId !== socket.id) {
          io.to(socketId).emit('ice-candidate', {
            candidate,
            senderSocketId: socket.id,
          });
        }
      });
    }
  });

  // Chat messaging
  socket.on('chat-message', (data) => {
    const { roomId, message, senderId, senderName, senderRole } = data;
    console.log(`💬 Chat message in ${roomId}: ${message}`);
    
    // Broadcast to all in room including sender
    if (rooms.has(roomId)) {
      rooms.get(roomId).forEach((socketId) => {
        io.to(socketId).emit('new-message', {
          message,
          senderId,
          senderName,
          senderRole,
          timestamp: new Date().toISOString(),
        });
      });
    }
  });

  // Join chat room
  socket.on('join-chat-room', (data) => {
    const { roomId } = data;
    socket.join(roomId);
    console.log(`💬 User ${socket.id} joined chat room ${roomId}`);
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const { roomId, userName, isTyping } = data;
    
    if (rooms.has(roomId)) {
      rooms.get(roomId).forEach((socketId) => {
        if (socketId !== socket.id) {
          io.to(socketId).emit('user-typing', { userName, isTyping });
        }
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const userId = socketToUser.get(socket.id);
    
    if (userId) {
      users.delete(userId);
      socketToUser.delete(socket.id);
      
      if (adminSocket === socket.id) {
        adminSocket = null;
        console.log(`👑 Admin disconnected: ${socket.id}`);
      }
      
      console.log(`👋 User disconnected: ${userId}`);
    }
    
    // Remove from all rooms
    rooms.forEach((socketIds, roomId) => {
      if (socketIds.has(socket.id)) {
        socketIds.delete(socket.id);
        socket.to(roomId).emit('user-left', { socketId: socket.id });
      }
    });
    
    console.log(`📱 User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Socket.io server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});
