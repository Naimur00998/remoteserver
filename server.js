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
      device: data.device,
      battery: data.battery || 0,
      network: data.network || 'unknown',
      isCharging: data.isCharging || false
    };
    console.log('Client connected:', data.name);
    broadcastClientList();
  });

  // Client info update (battery, network)
  socket.on('client_info', (data) => {
    if (clients[socket.id]) {
      clients[socket.id].battery = data.battery;
      clients[socket.id].network = data.network;
      clients[socket.id].isCharging = data.isCharging;
      broadcastClientList();
    }
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

  // Admin stops screen
  socket.on('stop_screen', (clientId) => {
    io.to(clientId).emit('stop_screen');
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

  // Admin launches app on client
  socket.on('launch_app', (data) => {
    io.to(data.clientId).emit('launch_app', { package: data.package });
  });

  // Admin requests app list
  socket.on('get_app_list', (clientId) => {
    io.to(clientId).emit('get_app_list');
  });

  // Client sends app list
  socket.on('app_list', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('app_list', {
        clientId: socket.id,
        apps: data.apps
      });
    });
  });

  // File transfer — admin to client
  socket.on('file_transfer', (data) => {
    io.to(data.clientId).emit('file_receive', {
      fileName: data.fileName,
      fileData: data.fileData,
      mimeType: data.mimeType
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete clients[socket.id];
    delete admins[socket.id];
    broadcastClientList();
  });

  function broadcastClientList() {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('client_list', Object.values(clients));
    });
  }
});

app.get('/', (req, res) => {
  res.send('Remote Server Running ✅');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
