'use strict';
/* ============================================================================
 * tools/nori_tap.js —— 契约录制器（迁移第 1 步）
 *
 * 目的：在**不改任何现有代码**的前提下，把"前端 ↔ 4173"这条链路上发生的一切
 *   录成可回放的文件，作为 Java 重写的 golden 基准。
 *
 * 原理：它是一个**旁路 tap**，不是代理改造——
 *   浏览器 → 4175(本进程，只旁听) → 4173(现有代理) → …
 *   ⇒ 录制期间行为与原链路一致；不想录了直接换回 4173。
 *
 * 录什么：
 *   · HTTP：方法 / 路径 / 请求体 / 状态码 / 响应体（超过上限的二进制只录摘要）
 *   · WS  ：双向每一帧（文本帧全量、二进制帧记 len+sha1，小的才存 base64）
 *   · 只录业务路径（默认 /api/arcade、/nori-*、/v1/*），静态资源不录
 *
 * 不录什么（安全）：
 *   · `authorization` / `cookie` / `x-api-key` 等头，一律丢弃
 *   · JSON 体里的 `*key*` / `*token*` / `secret` 字段，值替换为 "***"
 *
 * 用法：
 *   node tools/nori_tap.js                       # 4175 → 4173，录到 recordings/
 *   node tools/nori_tap.js --listen 4176 --up 127.0.0.1:4173 --out recordings
 *   node tools/nori_tap.js --max-body 65536      # 单条体积上限（字节）
 *   node tools/nori_tap.js --all                 # 录全部路径（含静态资源，文件会很大）
 *
 * 产物：recordings/YYYYMMDD_HHMMSS/
 *   ├─ session.jsonl   一行一条记录
 *   └─ meta.json       起始时间 / 上游 / 计数
 * ==========================================================================*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

function parseArgs(argv) {
  const a = { listen: 4175, upHost: '127.0.0.1', upPort: 4173, out: 'recordings', maxBody: 131072, all: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--listen') a.listen = Number(argv[++i]);
    else if (k === '--up') { const [h, p] = String(argv[++i]).split(':'); a.upHost = h || '127.0.0.1'; a.upPort = Number(p) || 4173; }
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--max-body') a.maxBody = Number(argv[++i]) || 131072;
    else if (k === '--all') a.all = true;
    else if (k === '--help' || k === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
  }
  return a;
}

const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|api-key|proxy-authorization)$/i;
const SECRET_FIELDS = /(key|token|secret|password|passwd|credential)/i;

function scrubHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (SECRET_HEADERS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/* JSON 体里的敏感字段替换成 ***（只处理一层对象/数组，够用） */
function scrubJson(obj) {
  if (Array.isArray(obj)) return obj.map(scrubJson);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.test(k) && typeof v === 'string') out[k] = '***';
    else out[k] = scrubJson(v);
  }
  return out;
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16); }

function isBizPath(u) {
  const p = String(u || '').split('?')[0];
  return p.startsWith('/api/arcade') || p.startsWith('/nori-') || p.startsWith('/v1/');
}

function start(opts) {
  const o = Object.assign({ listen: 4175, upHost: '127.0.0.1', upPort: 4173, out: 'recordings', maxBody: 131072, all: false }, opts || {});
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);   // YYYYMMDDHHmmss
  const dir = path.join(o.out, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'session.jsonl');
  const w = fs.createWriteStream(fp, { flags: 'a' });
  const t0 = Date.now();
  const st = { http: 0, wsUp: 0, wsDown: 0, skipped: 0 };
  let seq = 0;

  const rec = (obj) => {
    obj.i = ++seq;
    obj.t = Date.now() - t0;
    try { w.write(JSON.stringify(obj) + '\n'); } catch (e) {}
  };

  /* 响应体：小于上限就存全文（文本/JSON），否则只存摘要 */
  function packBody(buf, contentType) {
    const ct = String(contentType || '');
    const isText = /json|text|javascript|xml/i.test(ct);
    if (buf.length <= o.maxBody && (isText || buf.length <= 8192)) {
      return isText ? { enc: 'utf8', v: buf.toString('utf8') } : { enc: 'b64', v: buf.toString('base64') };
    }
    return { enc: 'skip', len: buf.length, sha1: sha1(buf), ct };
  }

  const server = http.createServer((req, res) => {
    if (!o.all && !isBizPath(req.url)) { st.skipped++; return proxyPlain(req, res, false); }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const reqBuf = Buffer.concat(chunks);
      let reqBody = null;
      const ct = String(req.headers['content-type'] || '');
      if (reqBuf.length) {
        if (/json/i.test(ct)) {
          try { reqBody = { enc: 'json', v: scrubJson(JSON.parse(reqBuf.toString('utf8'))) }; }
          catch (e) { reqBody = packBody(reqBuf, ct); }
        } else reqBody = packBody(reqBuf, ct);
      }
      const recHead = { k: 'http', m: req.method, u: req.url, h: scrubHeaders(req.headers), q: reqBody };
      const up = http.request({
        host: o.upHost, port: o.upPort, path: req.url, method: req.method,
        headers: Object.assign({}, req.headers, { host: o.upHost + ':' + o.upPort }),
      }, (ur) => {
        const outs = [];
        ur.on('data', (d) => outs.push(d));
        ur.on('end', () => {
          const body = Buffer.concat(outs);
          st.http++;
          rec(Object.assign(recHead, {
            s: ur.statusCode,
            rh: scrubHeaders(ur.headers),
            b: packBody(body, ur.headers['content-type']),
          }));
          try {
            res.writeHead(ur.statusCode || 502, ur.headers);
            res.end(body);
          } catch (e) {}
        });
      });
      up.on('error', (e) => {
        rec(Object.assign(recHead, { err: String(e && e.message) }));
        try { res.writeHead(502); res.end('tap upstream error: ' + e.message); } catch (e2) {}
      });
      up.end(reqBuf);
    });
  });

  /* 静态资源等不录的请求：直接过（不落盘） */
  function proxyPlain(req, res) {
    const up = http.request({
      host: o.upHost, port: o.upPort, path: req.url, method: req.method,
      headers: Object.assign({}, req.headers, { host: o.upHost + ':' + o.upPort }),
    }, (ur) => { try { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res); } catch (e) {} });
    up.on('error', () => { try { res.writeHead(502); res.end('tap upstream error'); } catch (e) {} });
    req.pipe(up);
  }

  /* ── WS 旁听 ───────────────────────────────────────────────────── */
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      const upUrl = 'ws://' + o.upHost + ':' + o.upPort + req.url;
      /* ★ 只透传"应用级"头：sec-websocket-* 由 ws 自己生成，重复传会握不上手 */
      const fwd = {};
      for (const k of ['origin', 'cookie', 'user-agent', 'accept-language']) {
        if (req.headers[k]) fwd[k] = req.headers[k];
      }
      const up = new WebSocket(upUrl, { headers: fwd });
      const pending = [];

      up.on('open', () => {
        rec({ k: 'ws-open', u: req.url });
        for (const p of pending) { try { up.send(p.d, { binary: p.b }); } catch (e) {} }
        pending.length = 0;
      });

      const relay = (from, to, dir) => (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (dir === 'up') st.wsUp++; else st.wsDown++;
        if (buf.length <= o.maxBody && (isBinary === false || buf.length <= 8192)) {
          rec({ k: 'ws', dir: dir, op: isBinary ? 'bin' : 'text',
                v: isBinary ? buf.toString('base64') : buf.toString('utf8') });
        } else {
          rec({ k: 'ws', dir: dir, op: isBinary ? 'bin' : 'text',
                hash: { len: buf.length, sha1: sha1(buf) } });
        }
        try { if (to.readyState === WebSocket.OPEN) to.send(buf, { binary: !!isBinary }); else if (dir === 'up') pending.push({ d: buf, b: !!isBinary }); } catch (e) {}
      };

      client.on('message', relay(client, up, 'up'));
      up.on('message', relay(up, client, 'down'));
      client.on('close', () => { try { up.close(); } catch (e) {} rec({ k: 'ws-close', dir: 'client' }); });
      up.on('close', () => { try { client.close(); } catch (e) {} rec({ k: 'ws-close', dir: 'up' }); });
      client.on('error', () => {});
      up.on('error', (e) => { rec({ k: 'ws-err', m: String(e && e.message) }); });
    });
  });

  server.listen(o.listen, '127.0.0.1', () => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      startedAt: new Date().toISOString(), listen: o.listen,
      upstream: o.upHost + ':' + o.upPort, maxBody: o.maxBody, all: o.all,
    }, null, 2));
    console.log('[tap] listening 127.0.0.1:' + o.listen + '  →  ' + o.upHost + ':' + o.upPort);
    console.log('[tap] recording to ' + path.resolve(fp));
  });

  return { server, dir, file: fp, stats: st, close: () => new Promise((r) => { try { wss.close(); } catch (e) {} server.close(() => { w.end(); r(); }); }) };
}

module.exports = { start, parseArgs };

if (require.main === module) {
  const a = parseArgs(process.argv);
  const t = start(a);
  const stop = () => { console.log('[tap] ' + JSON.stringify(t.stats)); t.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
