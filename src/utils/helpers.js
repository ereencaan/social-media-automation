const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');

function generateId() {
  return uuidv4();
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function formatDate(date) {
  return new Date(date).toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = { generateId, downloadImage, formatDate };
