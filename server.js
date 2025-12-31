const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('8 Ball Pool WebSocket Server');
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// Store active rooms
const rooms = new Map();

// Generate random room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Send JSON message to client
function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// Broadcast to all players in a room except sender
function broadcastToRoom(roomCode, type, data, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.players.forEach(player => {
    if (player.ws !== excludeWs) {
      send(player.ws, type, data);
    }
  });
}

// Send to all players in room including sender
function sendToRoom(roomCode, type, data) {
  broadcastToRoom(roomCode, type, data, null);
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.roomCode = null;
  ws.playerNumber = null;
  
  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.log('Invalid JSON:', message);
      return;
    }
    
    console.log('Received:', msg.type, msg);
    
    switch (msg.type) {
      
      case 'create_room': {
        // Generate unique room code
        let roomCode;
        do {
          roomCode = generateRoomCode();
        } while (rooms.has(roomCode));
        
        // Create room
        rooms.set(roomCode, {
          players: [{ ws, name: msg.name || 'Player 1' }],
          currentTurn: 1,
          gameStarted: false,
          ballPositions: null
        });
        
        ws.roomCode = roomCode;
        ws.playerNumber = 1;
        
        send(ws, 'room_created', { roomCode, playerNumber: 1 });
        console.log(`Room ${roomCode} created`);
        break;
      }
      
      case 'join_room': {
        const roomCode = msg.roomCode.toUpperCase();
        const room = rooms.get(roomCode);
        
        if (!room) {
          send(ws, 'error', { message: 'Room not found' });
          return;
        }
        
        if (room.players.length >= 2) {
          send(ws, 'error', { message: 'Room is full' });
          return;
        }
        
        // Add player to room
        room.players.push({ ws, name: msg.name || 'Player 2' });
        ws.roomCode = roomCode;
        ws.playerNumber = 2;
        
        send(ws, 'room_joined', { 
          roomCode, 
          playerNumber: 2,
          opponentName: room.players[0].name
        });
        
        // Notify player 1
        send(room.players[0].ws, 'opponent_joined', {
          opponentName: msg.name || 'Player 2'
        });
        
        // Start game
        room.gameStarted = true;
        room.currentTurn = 1;
        
        sendToRoom(roomCode, 'game_start', {
          currentTurn: 1,
          player1Name: room.players[0].name,
          player2Name: room.players[1].name
        });
        
        console.log(`Player joined room ${roomCode}, game starting`);
        break;
      }
      
      case 'aim_update': {
        // Relay aiming info to opponent (live aim preview)
        if (ws.roomCode) {
          broadcastToRoom(ws.roomCode, 'opponent_aim', {
            aiming: msg.aiming,
            direction: msg.direction,
            power: msg.power
          }, ws);
        }
        break;
      }
      
      case 'shoot': {
        // Relay shot to opponent
        if (ws.roomCode) {
          const room = rooms.get(ws.roomCode);
          if (room && room.currentTurn === ws.playerNumber) {
            broadcastToRoom(ws.roomCode, 'opponent_shot', {
              direction: msg.direction,
              power: msg.power
            }, ws);
          }
        }
        break;
      }
      
      case 'turn_end': {
        // Called when balls stop moving, sync positions and switch turn
        if (ws.roomCode) {
          const room = rooms.get(ws.roomCode);
          if (room) {
            // Switch turn
            room.currentTurn = room.currentTurn === 1 ? 2 : 1;
            
            sendToRoom(ws.roomCode, 'turn_change', {
              currentTurn: room.currentTurn,
              ballPositions: msg.ballPositions,
              scores: msg.scores,
              pocketed: msg.pocketed
            });
          }
        }
        break;
      }
      
      case 'ball_pocketed': {
        // Sync when a ball is pocketed
        if (ws.roomCode) {
          broadcastToRoom(ws.roomCode, 'ball_pocketed', {
            ballNumber: msg.ballNumber
          }, ws);
        }
        break;
      }
      
      case 'game_over': {
        if (ws.roomCode) {
          sendToRoom(ws.roomCode, 'game_over', {
            winner: msg.winner
          });
        }
        break;
      }
      
      case 'rematch': {
        if (ws.roomCode) {
          const room = rooms.get(ws.roomCode);
          if (room) {
            if (!room.rematchVotes) room.rematchVotes = new Set();
            room.rematchVotes.add(ws.playerNumber);
            
            if (room.rematchVotes.size >= 2) {
              // Both want rematch
              room.rematchVotes.clear();
              room.currentTurn = 1;
              sendToRoom(ws.roomCode, 'rematch_start', {
                currentTurn: 1
              });
            } else {
              // Notify other player
              broadcastToRoom(ws.roomCode, 'rematch_request', {}, ws);
            }
          }
        }
        break;
      }
      
      case 'chat': {
        if (ws.roomCode) {
          broadcastToRoom(ws.roomCode, 'chat', {
            message: msg.message,
            from: ws.playerNumber
          }, ws);
        }
        break;
      }
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        // Notify other player
        broadcastToRoom(ws.roomCode, 'opponent_left', {}, ws);
        
        // Remove player from room
        room.players = room.players.filter(p => p.ws !== ws);
        
        // Delete room if empty
        if (room.players.length === 0) {
          rooms.delete(ws.roomCode);
          console.log(`Room ${ws.roomCode} deleted`);
        }
      }
    }
  });
  
  ws.on('error', (error) => {
    console.log('WebSocket error:', error);
  });
  
  // Track if client is alive
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Keep alive ping every 25 seconds (under most platform timeouts)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log('Terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// Start HTTP server
server.listen(PORT, () => {
  console.log(`8 Ball Pool server running on port ${PORT}`);
});
