const http = require('http');

const PORT = process.env.PORT || 3000;

// Store rooms and messages
const rooms = new Map();
const messageQueues = new Map(); // playerId -> [messages]

// Generate random codes
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generatePlayerId() {
  return Math.random().toString(36).substring(2, 15);
}

// Get or create message queue for player
function getQueue(playerId) {
  if (!messageQueues.has(playerId)) {
    messageQueues.set(playerId, []);
  }
  return messageQueues.get(playerId);
}

// Send message to player's queue
function sendToPlayer(playerId, message) {
  const queue = getQueue(playerId);
  queue.push(message);
}

// Send to all players in room except one
function sendToRoomExcept(roomCode, exceptPlayerId, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.players.forEach(player => {
    if (player.id !== exceptPlayerId) {
      sendToPlayer(player.id, message);
    }
  });
}

// Send to all players in room
function sendToRoom(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.players.forEach(player => {
    sendToPlayer(player.id, message);
  });
}

// Handle requests
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Parse URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  
  // Health check
  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('8 Ball Pool Server OK');
    return;
  }
  
  // Handle POST requests
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        handleAction(path, data, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  
  // Handle GET requests (polling)
  if (req.method === 'GET' && path === '/poll') {
    const playerId = url.searchParams.get('playerId');
    if (!playerId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing playerId' }));
      return;
    }
    
    const queue = getQueue(playerId);
    const messages = queue.splice(0, queue.length); // Get and clear
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function handleAction(path, data, res) {
  const response = { success: true };
  
  switch (path) {
    case '/create': {
      const playerId = generatePlayerId();
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));
      
      rooms.set(roomCode, {
        players: [{ id: playerId, name: data.name || 'Player 1', number: 1 }],
        currentTurn: 1,
        gameStarted: false
      });
      
      response.playerId = playerId;
      response.roomCode = roomCode;
      response.playerNumber = 1;
      console.log(`Room ${roomCode} created by ${data.name}`);
      break;
    }
    
    case '/join': {
      const roomCode = (data.roomCode || '').toUpperCase();
      const room = rooms.get(roomCode);
      
      if (!room) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Room not found' }));
        return;
      }
      
      if (room.players.length >= 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Room is full' }));
        return;
      }
      
      const playerId = generatePlayerId();
      const playerName = data.name || 'Player 2';
      room.players.push({ id: playerId, name: playerName, number: 2 });
      room.gameStarted = true;
      
      response.playerId = playerId;
      response.roomCode = roomCode;
      response.playerNumber = 2;
      response.opponentName = room.players[0].name;
      
      // Notify player 1
      sendToPlayer(room.players[0].id, {
        type: 'opponent_joined',
        opponentName: playerName
      });
      
      // Send game start to both
      sendToRoom(roomCode, {
        type: 'game_start',
        currentTurn: 1,
        player1Name: room.players[0].name,
        player2Name: playerName
      });
      
      console.log(`${playerName} joined room ${roomCode}`);
      break;
    }
    
    case '/shoot': {
      const room = rooms.get(data.roomCode);
      if (room) {
        sendToRoomExcept(data.roomCode, data.playerId, {
          type: 'opponent_shot',
          direction: data.direction,
          power: data.power
        });
      }
      break;
    }
    
    case '/aim': {
      const room = rooms.get(data.roomCode);
      if (room) {
        sendToRoomExcept(data.roomCode, data.playerId, {
          type: 'opponent_aim',
          aiming: data.aiming,
          direction: data.direction,
          power: data.power
        });
      }
      break;
    }
    
    case '/turn_end': {
      const room = rooms.get(data.roomCode);
      if (room) {
        room.currentTurn = room.currentTurn === 1 ? 2 : 1;
        sendToRoom(data.roomCode, {
          type: 'turn_change',
          currentTurn: room.currentTurn,
          ballPositions: data.ballPositions,
          scores: data.scores
        });
      }
      break;
    }
    
    case '/leave': {
      const room = rooms.get(data.roomCode);
      if (room) {
        sendToRoomExcept(data.roomCode, data.playerId, {
          type: 'opponent_left'
        });
        room.players = room.players.filter(p => p.id !== data.playerId);
        if (room.players.length === 0) {
          rooms.delete(data.roomCode);
          console.log(`Room ${data.roomCode} deleted`);
        }
      }
      // Clean up message queue
      messageQueues.delete(data.playerId);
      break;
    }
    
    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown action' }));
      return;
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

// Clean up old empty rooms periodically
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.length === 0) {
      rooms.delete(code);
    }
  });
}, 60000);

server.listen(PORT, () => {
  console.log(`8 Ball Pool HTTP server running on port ${PORT}`);
});
