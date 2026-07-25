const net = require('net');
const WebSocket = require('ws'); 

const TUNNEL_URL = process.env.TUNNEL_URL;
const PORT = 8081;

if (!TUNNEL_URL) {
  console.error("No TUNNEL_URL found, proxy won't work.");
}

const server = net.createServer((clientSocket) => {
  clientSocket.once('data', (data) => {
    const reqStr = data.toString('utf8');
    const firstLine = reqStr.split('\r\n')[0];
    const [method, url] = firstLine.split(' ');

    if (method === 'CONNECT' && TUNNEL_URL) {
      const [host, port] = url.split(':');
      
      const wsUrl = TUNNEL_URL.replace(/^http/, 'ws') + `/ws-connect?host=${host}&port=${port}`;
      const ws = new WebSocket(wsUrl);
      
      ws.once('message', (msg) => {
        if (msg.toString() === 'connected') {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          
          ws.on('message', (chunk) => clientSocket.write(chunk));
          clientSocket.on('data', (chunk) => ws.send(chunk));
        }
      });
      
      ws.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => ws.close());
      
      ws.on('error', (err) => {
        console.error('WS Error:', err.message);
        clientSocket.destroy();
      });
    } else {
      // Basic fallback for non-CONNECT requests or missing tunnel
      clientSocket.destroy(); 
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Render Local WS-TCP Bridge listening on ${PORT}`);
});
