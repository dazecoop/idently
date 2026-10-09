const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = 5050;

// sessionId -> { username, serial, createdAt }
const sessions = new Map();
let serialCounter = 0;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function page(body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Container Test Site</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 420px; margin: 60px auto; color: #1c1c1e; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 24px; }
  h1 { font-size: 18px; margin-top: 0; }
  input { width: 100%; padding: 8px 10px; margin: 6px 0 14px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; font-size: 14px; }
  button { background: #5b5bd6; color: #fff; border: none; padding: 9px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .serial { font-size: 40px; font-weight: 700; margin: 4px 0 2px; }
  .meta { color: #666; font-size: 12px; line-height: 1.6; }
  a.logout { color: #d6455b; font-size: 13px; text-decoration: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; background: #f0f0f3; font-size: 11px; color: #666; }
</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

function loginForm(note = "") {
  return page(`
    <h1>Container Test Site</h1>
    <p class="meta">No active session on this cookie jar. If you're testing container isolation, this page should ask you to log in separately per container.</p>
    ${note ? `<p class="meta">${note}</p>` : ""}
    <form method="POST" action="/login">
      <label>Username<br/><input name="username" placeholder="e.g. work-account" required /></label>
      <button type="submit">Log in</button>
    </form>
  `);
}

function dashboard(session) {
  return page(`
    <span class="badge">Logged in</span>
    <div class="serial">Session ${session.serial}</div>
    <div class="meta">
      Username: <strong>${escapeHtml(session.username)}</strong><br/>
      Cookie value: <code>${session.id.slice(0, 12)}…</code><br/>
      Logged in at ${new Date(session.createdAt).toLocaleTimeString()}
    </div>
    <p><a class="logout" href="/logout">Log out of this session</a></p>
  `);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.sid;
  const session = sid && sessions.get(sid);

  if (url.pathname === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const username = (params.get("username") || "anonymous").slice(0, 60);
    const newSid = crypto.randomUUID();
    serialCounter += 1;
    sessions.set(newSid, { id: newSid, username, serial: serialCounter, createdAt: Date.now() });
    res.writeHead(302, {
      "Set-Cookie": `sid=${newSid}; Path=/; HttpOnly; SameSite=Lax`,
      Location: "/"
    });
    res.end();
    return;
  }

  if (url.pathname === "/logout") {
    if (sid) sessions.delete(sid);
    res.writeHead(302, {
      "Set-Cookie": "sid=; Path=/; HttpOnly; Max-Age=0",
      Location: "/"
    });
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(session ? dashboard(session) : loginForm());
});

server.listen(PORT, () => {
  console.log(`Test site running at http://localhost:${PORT}`);
});
