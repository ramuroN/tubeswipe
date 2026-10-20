'use strict';
// A stand-in for MeTube's /browse and /add, for the tests and for trying the UI
// without MeTube: `npm run mock`, then start TubeSwipe with METUBE_URL=http://localhost:8081.
// /add only records what it gets; nothing is downloaded.

const http = require('node:http');

// Blender Foundation open movies, so the cards show real thumbnails.
const SAMPLE = {
  title: 'Blender - Videos',
  entries: [
    ['UXqq0ZvbOnk', 'CHARGE - Blender Open Movie', 249],
    ['mN0zPOpADL4', 'Agent 327: Operation Barbershop', 231],
    ['WhWc3b3KhnY', 'Spring - Blender Open Movie', 464],
    ['Y-rmzh0PI3c', 'Cosmos Laundromat - First Cycle. Official Blender Foundation release.', 730],
    ['SkVqJ1SGeL0', 'Caminandes 3: Llamigos', 150],
    ['R6MlUcmOul8', 'Tears of Steel - Blender VFX Open Movie', 734],
    ['eRsGyueVLvQ', 'Sintel - Open Movie by Blender Foundation', 888],
    ['aqz-KE-bpKQ', 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', 635],
  ].map(([id, title, duration]) => ({ url: 'https://www.youtube.com/watch?v=' + id, title, duration })),
};

// catalog maps a source URL to { title, entries }; without one, every URL gets SAMPLE.
function createMockMetube(catalog = null) {
  const added = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {}
      const reply = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'POST' && req.url === '/browse') {
        const listing = catalog ? catalog[body.url] : SAMPLE;
        if (!listing) return reply({ status: 'error', msg: 'Unsupported URL' });
        const limit = body.playlist_item_limit || listing.entries.length;
        return reply({ status: 'ok', title: listing.title, entries: listing.entries.slice(0, limit) });
      }
      if (req.method === 'POST' && req.url === '/add') {
        added.push(body);
        return reply({ status: 'ok' });
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, added };
}

module.exports = { createMockMetube, SAMPLE };

// A bare `node --test` treats every file under test/ as a test; do not listen then.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  const port = Number(process.env.PORT || 8081);
  const { server, added } = createMockMetube();
  server.listen(port, () => console.log(`Mock MeTube on http://localhost:${port}`));
  setInterval(() => added.length && console.log('/add:', JSON.stringify(added.splice(0))), 1000);
}
