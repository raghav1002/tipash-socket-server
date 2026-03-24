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
      'https://www.tipashluxuries.com',
      'http://localhost:3000',
      'http://localhost:3001'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  perMessageDeflate: false,
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
  
  // Store pending video offers (roomId -> { offer, callerId, callerName, timestamp })
  const pendingVideoOffers = new Map();
  // Store ICE candidates that arrive before answer (roomId -> Array of candidates)
  const pendingIceCandidates = new Map();
  // Track which users have answered in each room (to avoid duplicate answers)
  const roomAnsweredUsers = new Map(); // roomId -> Set of socketIds that have answered
  
  // Join video room
  socket.on('join-video-room', (data) => {
    const { roomId, userId, userName, isAdmin } = data;
    
    if (!videoRooms.has(roomId)) {
      videoRooms.set(roomId, new Set());
    }
    videoRooms.get(roomId).add(socket.id);
    socketToVideoRoom.set(socket.id, roomId);
    
    socket.join(roomId);
    users.set(userId, socket.id);
    socketToUser.set(socket.id, userId);
    
    console.log(`📹 User ${userName} (${isAdmin ? 'admin' : 'user'}) joined video room ${roomId}`);
    
    // If admin joins, check if there's a pending offer from user
    if (isAdmin && pendingVideoOffers.has(roomId)) {
      const pending = pendingVideoOffers.get(roomId);
      const offerAge = Date.now() - (pending.timestamp || 0);
      
      // Only forward offers that are less than 30 seconds old
      if (offerAge < 30000) {
        console.log(`📹 Admin joining - sending pending offer from ${pending.callerName} (age: ${offerAge}ms)`);
        socket.emit('video-offer', {
          offer: pending.offer,
          callerId: pending.callerId,
          callerName: pending.callerName,
          roomId
        });
        
        // Also forward any pending ICE candidates for this room
        if (pendingIceCandidates.has(roomId)) {
          const candidates = pendingIceCandidates.get(roomId);
          console.log(`📹 Forwarding ${candidates.length} pending ICE candidates to admin`);
          candidates.forEach(candidate => {
            socket.emit('video-ice-candidate', { candidate });
          });
        }
      } else {
        console.log(`📹 Pending offer too old (${offerAge}ms), clearing it`);
        pendingVideoOffers.delete(roomId);
        pendingIceCandidates.delete(roomId);
      }
    }
    
    // Notify others in room about the new participant
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
    console.log(`📹 Video offer in room: ${roomId} from ${callerName}`);
    
    // Store pending offer for admins who join later (with timestamp)
    pendingVideoOffers.set(roomId, { offer, callerId, callerName, timestamp: Date.now() });
    
    // Reset room answered users for new call
    roomAnsweredUsers.delete(roomId);
    
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
        // Broadcast to all others in room (admins)
        let sentCount = 0;
        videoRooms.get(roomId).forEach((socketId) => {
          if (socketId !== socket.id) {
            io.to(socketId).emit('video-offer', {
              offer,
              callerId,
              callerName,
              roomId
            });
            sentCount++;
          }
        });
        console.log(`📹 Offer sent to ${sentCount} participant(s) in room ${roomId}`);
      }
    } else {
      console.log(`📹 No one in room ${roomId} yet, offer stored for later`);
    }
  });

  // Video answer
  socket.on('video-answer', (data) => {
    const { roomId, answer, callerId } = data;
    console.log(`📹 Video answer in room: ${roomId}`);
    
    // Track who has answered to prevent duplicate answers
    if (!roomAnsweredUsers.has(roomId)) {
      roomAnsweredUsers.set(roomId, new Set());
    }
    roomAnsweredUsers.get(roomId).add(socket.id);
    
    // Clear pending offer since answer was received
    pendingVideoOffers.delete(roomId);
    // Clear pending ICE candidates since answer was received
    pendingIceCandidates.delete(roomId);
    
    const callerSocketId = users.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('video-answer', { answer, answererId: socket.id });
      console.log(`📹 Answer forwarded to caller ${callerId}`);
    } else {
      console.log(`📹 Could not find caller socket for ${callerId}`);
    }
  });

  // Video ICE candidate
  socket.on('video-ice-candidate', (data) => {
    const { roomId, candidate } = data;
    
    if (videoRooms.has(roomId)) {
      // Forward to all others in the room
      let forwardedCount = 0;
      videoRooms.get(roomId).forEach((socketId) => {
        if (socketId !== socket.id) {
          io.to(socketId).emit('video-ice-candidate', { candidate });
          forwardedCount++;
        }
      });
      
      if (forwardedCount === 0) {
        // No one to forward to yet, store for later
        if (!pendingIceCandidates.has(roomId)) {
          pendingIceCandidates.set(roomId, []);
        }
        pendingIceCandidates.get(roomId).push(candidate);
        console.log(`📹 Stored ICE candidate for room ${roomId} (no recipients yet)`);
      }
    } else {
      // Room doesn't exist yet, store for later
      if (!pendingIceCandidates.has(roomId)) {
        pendingIceCandidates.set(roomId, []);
      }
      pendingIceCandidates.get(roomId).push(candidate);
      console.log(`📹 Stored ICE candidate for room ${roomId} (room not created yet)`);
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
        if (socketId !== socket.id) {
          io.to(socketId).emit('video-call-ended', { reason: 'Call ended by ' + userId });
        }
      });
      videoRooms.delete(roomId);
    }
    
    // Clean up pending data
    pendingVideoOffers.delete(roomId);
    pendingIceCandidates.delete(roomId);
    roomAnsweredUsers.delete(roomId);
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
    const videoRoomId = socketToVideoRoom.get(socket.id);
    
    if (userId) {
      users.delete(userId);
      socketToUser.delete(socket.id);
      
      if (adminSocket === socket.id) {
        adminSocket = null;
        console.log(`👑 Admin disconnected: ${socket.id}`);
      }
      
      console.log(`👋 User disconnected: ${userId}`);
    }
    
    // Remove from video rooms and notify others
    if (videoRoomId && videoRooms.has(videoRoomId)) {
      videoRooms.get(videoRoomId).delete(socket.id);
      socket.to(videoRoomId).emit('video-user-left', { socketId: socket.id, userId });
      socketToVideoRoom.delete(socket.id);
      
      // If room is now empty, clean up pending data
      if (videoRooms.get(videoRoomId).size === 0) {
        videoRooms.delete(videoRoomId);
        pendingVideoOffers.delete(videoRoomId);
        pendingIceCandidates.delete(videoRoomId);
        roomAnsweredUsers.delete(videoRoomId);
        console.log(`📹 Cleaned up empty video room: ${videoRoomId}`);
      }
    }
    
    // Remove from all regular rooms
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
