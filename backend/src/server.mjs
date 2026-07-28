import http from 'node:http';

const port = Number(process.env.PORT || 3001);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'e-posyandu-backend' }));
    return;
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
});

server.listen(port, () => {
  console.log(`Backend server running at http://localhost:${port}`);
});
