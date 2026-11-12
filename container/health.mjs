import { request } from 'node:http';

const token = process.env['HAVEN_API_TOKEN'];
const port = Number(process.env['PORT'] ?? 3000);
if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('Health check requires HAVEN_API_TOKEN and a valid PORT');
  process.exitCode = 1;
} else {
  const req = request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/health',
      headers: { authorization: `Bearer ${token}` },
      timeout: 4000,
    },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy(new Error('Unexpected health response size'));
      });
      response.on('error', () => {
        process.exitCode = 1;
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 || JSON.parse(body).status !== 'ok') {
            process.exitCode = 1;
          }
        } catch {
          process.exitCode = 1;
        }
      });
    },
  );
  req.on('timeout', () => req.destroy(new Error('Health check timed out')));
  req.on('error', () => {
    console.error('API health check failed');
    process.exitCode = 1;
  });
  req.end();
}
