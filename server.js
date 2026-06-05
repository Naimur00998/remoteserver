const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

let clients = {};
let admins = {};

io.on('connection', (socket) => {

  // Client register
  socket.on('register_client', (data) => {
    clients[socket.id] = {
      id: socket.id,
      name: data.name,
      device: data.device
    };
    console.log('Client connected:', data.name);
    // Notify all admins
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('client_list', Object.values(clients));
    });
  });

  // Admin register
  socket.on('register_admin', () => {
    admins[socket.id] = true;
    socket.emit('client_list', Object.values(clients));
    console.log('Admin connected');
  });

  // Admin requests screen
  socket.on('request_screen', (clientId) => {
    io.to(clientId).emit('start_screen');
  });

  // Client sends screen data
  socket.on('screen_data', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('screen_frame', {
        clientId: socket.id,
        frame: data.frame
      });
    });
  });

  // Admin sends touch event
  socket.on('touch_event', (data) => {
    io.to(data.clientId).emit('perform_touch', {
      x: data.x,
      y: data.y,
      action: data.action
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete clients[socket.id];
    delete admins[socket.id];
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('client_list', Object.values(clients));
    });
  });

});

app.get('/', (req, res) => {
  res.send('Remote Server Running ✅');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});