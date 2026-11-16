import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './server/api.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(root, 'dist');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const api = createApiHandler();
const server = createServer((request, response) => {
  api(request, response, () => {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    const requested = resolve(dist, `.${pathname}`);
    const file = requested.startsWith(`${dist}${sep}`) && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : resolve(dist, 'index.html');
    response.setHeader('Content-Type', mimeTypes[extname(file)] || 'application/octet-stream');
    createReadStream(file).pipe(response);
  });
});

const port = Number(process.env.PORT || 4175);
server.listen(port, '127.0.0.1', () => {
  console.log(`OpenCHAMI console listening at http://127.0.0.1:${port}`);
});