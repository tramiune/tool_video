const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:7788');
ws.on('open', () => {
  console.log('Connected!');
  ws.close();
});
