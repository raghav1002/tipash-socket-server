// Socket.io server for video calling - deploy separately on Render.com
const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 10000;

const server = createServer();

// Allowed origins for CORS
const allowedOrigins = [
  'https://tipashluxuries.com',
  'https://www.tipashluxuries.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002'
];

// Configure CORS for production - optimized for shared hosting
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      // Allow any localhost origin for development
      if (origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) {
        return callback(null, true);
      }
      
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Polling first for shared hosting compatibility, WebSocket as upgrade
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowUpgrades: true,
  path: '/socket.io/',
  // HTTP compression for polling transport
  httpCompression: true,
  // Per-message deflate for WebSocket
  perMessageDeflate: {
    threshold: 1024
  }
});

// Store connected users and their socket IDs
const users = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId
const rooms = new Map(); // roomId -> Set of socketIds
const videoRooms = new Map(); // roomId -> Set of socketIds for video calls
const socketToVideoRoom = new Map(); // socketId -> roomId for video calls
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

  // ===== Professional Video Call Handlers =====
  
  // Store pending video offers (roomId -> { offer, callerId, callerName })
  const pendingVideoOffers = new Map();
  
  // Join video room
  socket.on('join-video-room', (data) => {
    const { roomId, userId, userName, isAdmin } = data;
    console.log(`📹 join-video-room: ${userName} (${userId}) joining ${roomId}`);
    
    if (!videoRooms.has(roomId)) {
      videoRooms.set(roomId, new Set());
    }
    videoRooms.get(roomId).add(socket.id);
    socketToVideoRoom.set(socket.id, roomId);
    
    socket.join(roomId);
    users.set(userId, socket.id);
    socketToUser.set(socket.id, userId);
    
    console.log(`📹 User ${userName} (${isAdmin ? 'admin' : 'user'}) joined video room ${roomId}, socket: ${socket.id}`);
    console.log(`📹 users map updated: ${userId} -> ${socket.id}`);
    
    // If admin joins, check if there's a pending offer from user
    if (isAdmin && pendingVideoOffers.has(roomId)) {
      const pending = pendingVideoOffers.get(roomId);
      console.log(`📹 Admin joining - sending pending offer from ${pending.callerName}`);
      socket.emit('video-offer', {
        offer: pending.offer,
        callerId: pending.callerId,
        callerName: pending.callerName,
        roomId
      });
    }
    
    // Notify others in room
    socket.to(roomId).emit('video-user-joined', { socketId: socket.id, userId, userName });
  });

  // Leave video room
  socket.on('leave-video-room', (data) => {
    const { roomId } = data;
    
    if (videoRooms.has(roomId)) {
      videoRooms.get(roomId).delete(socket.id);
      socketToVideoRoom.delete(socket.id);
      socket.leave(roomId);
      console.log(`📹 User left video room ${roomId}`);
      
      // Notify others
      socket.to(roomId).emit('video-user-left', { socketId: socket.id });
    }
  });

  // Video offer
  socket.on('video-offer', (data) => {
    const { roomId, offer, callerId, callerName, targetSocketId } = data;
    console.log(`📹 Video offer in room: ${roomId} from ${callerName} (${callerId})`);
    console.log(`📹 targetSocketId: ${targetSocketId}`);
    console.log(`📹 videoRooms has ${roomId}:`, videoRooms.has(roomId));
    
    // Store pending offer for admins who join later
    pendingVideoOffers.set(roomId, { offer, callerId, callerName });
    
    if (videoRooms.has(roomId)) {
      if (targetSocketId) {
        // Send to specific user
        io.to(targetSocketId).emit('video-offer', {
          offer,
          callerId,
          callerName,
          roomId
        });
      } else {
        // Broadcast to all others in room
        videoRooms.get(roomId).forEach((socketId) => {
          if (socketId !== socket.id) {
            io.to(socketId).emit('video-offer', {
              offer,
              callerId,
              callerName,
              roomId
            });
          }
        });
      }
    }
  });

  // Offer ready - admin signals they're ready to receive offer
  socket.on('offer-ready', (data) => {
    const { roomId } = data;
    console.log(`📹 Offer ready signal in room: ${roomId} from socket: ${socket.id}`);
    
    // Forward to all other users in the room (the caller)
    if (videoRooms.has(roomId)) {
      const roomSockets = Array.from(videoRooms.get(roomId));
      console.log(`📹 Room ${roomId} has sockets:`, roomSockets);
      roomSockets.forEach((targetSocketId) => {
        if (targetSocketId !== socket.id) {
          console.log(`📹 Forwarding offer-ready to socket: ${targetSocketId}`);
          io.to(targetSocketId).emit('offer-ready', { roomId });
        }
      });
    } else {
      console.log(`📹 Room ${roomId} not found for offer-ready!`);
    }
  });

  // Video answer
  socket.on('video-answer', (data) => {
    const { roomId, answer, callerId } = data;
    console.log(`📹 Video answer in room: ${roomId}, for caller: ${callerId}`);
    console.log(`📹 Answer type:`, answer?.type);
    console.log(`📹 Current users map:`, Array.from(users.entries()));
    console.log(`📹 Current videoRooms:`, Array.from(videoRooms.entries()).map(([k, v]) => [k, Array.from(v)]));
    
    // Clear pending offer since answer was received
    pendingVideoOffers.delete(roomId);
    
    // Try to send to specific caller first
    const callerSocketId = users.get(callerId);
    console.log(`📹 Looking up callerId ${callerId}, found socket: ${callerSocketId}`);
    
    if (callerSocketId) {
      io.to(callerSocketId).emit('video-answer', { answer, roomId });
      console.log(`📹 Answer sent to caller socket: ${callerSocketId}`);
    } else {
      // Fallback: broadcast to all others in the room
      console.log(`📹 Caller not found by ID, broadcasting to room: ${roomId}`);
      if (videoRooms.has(roomId)) {
        const roomSockets = Array.from(videoRooms.get(roomId));
        console.log(`📹 Room sockets:`, roomSockets);
        roomSockets.forEach((socketId) => {
          if (socketId !== socket.id) {
            console.log(`📹 Broadcasting answer to socket: ${socketId}`);
            io.to(socketId).emit('video-answer', { answer, roomId });
          }
        });
      } else {
        console.log(`📹 Video room ${roomId} not found!`);
      }
    }
  });

  // Video ICE candidate
  socket.on('video-ice-candidate', (data) => {
    const { roomId, candidate } = data;
    console.log(`📹 ICE candidate in room: ${roomId}, candidate:`, candidate?.candidate?.substring(0, 50));
    
    if (videoRooms.has(roomId)) {
      const roomSockets = Array.from(videoRooms.get(roomId));
      console.log(`📹 Forwarding ICE to ${roomSockets.length - 1} other sockets`);
      roomSockets.forEach((targetSocketId) => {
        if (targetSocketId !== socket.id) {
          io.to(targetSocketId).emit('video-ice-candidate', { candidate });
        }
      });
    } else {
      console.log(`📹 ICE: Room ${roomId} not found!`);
    }
  });

  // Accept video call
  socket.on('video-accept-call', (data) => {
    const { roomId, userId } = data;
    console.log(`📹 Video call accepted in room: ${roomId}`);
    
    if (videoRooms.has(roomId)) {
      videoRooms.get(roomId).forEach((socketId) => {
        if (socketId !== socket.id) {
          io.to(socketId).emit('video-call-accepted', { roomId, userId });
        }
      });
    }
  });

  // End video call
  socket.on('end-video-call', (data) => {
    const { roomId, userId } = data;
    console.log(`📹 Video call ended in room: ${roomId}`);
    
    if (videoRooms.has(roomId)) {
      videoRooms.get(roomId).forEach((socketId) => {
        io.to(socketId).emit('video-call-ended', { reason: 'Call ended by ' + userId });
      });
      videoRooms.delete(roomId);
    }
  });

  // Incoming video call notification
  socket.on('incoming-video-call', (data) => {
    const { callerId, callerName, roomId } = data;
    console.log(`📹 Incoming video call from ${callerName}`);
    
    // Notify admin
    if (adminSocket) {
      io.to(adminSocket).emit('incoming-video-call', {
        callerId,
        callerName,
        roomId,
        socketId: socket.id
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
