const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      'https://pmartin5-gif.github.io',
      'https://carolynz.github.io',
      'http://localhost:3000',
      'http://localhost:4444',
    ],
    methods: ['GET', 'POST'],
  },
});

const DATA_FILE = path.join(__dirname, 'data.json');
let state = { strokes: [], stickers: [] };

if (fs.existsSync(DATA_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not load saved state, starting fresh');
  }
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
}

app.use(express.static(path.join(__dirname, 'docs')));

io.on('connection', (socket) => {
  const count = io.engine.clientsCount;
  io.emit('visitors', count);

  // Send current wall state to new visitor
  socket.emit('init', state);

  socket.on('stroke', (stroke) => {
    if (!stroke || !stroke.id || !Array.isArray(stroke.points)) return;
    state.strokes.push(stroke);
    save();
    socket.broadcast.emit('stroke', stroke);
  });

  socket.on('sticker', (sticker) => {
    if (!sticker || !sticker.id || !sticker.text) return;
    state.stickers.push(sticker);
    save();
    socket.broadcast.emit('sticker', sticker);
  });

  socket.on('disconnect', () => {
    io.emit('visitors', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`THE VOID is open at http://localhost:${PORT}`);
});
