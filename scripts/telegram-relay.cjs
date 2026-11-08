// Standalone Node 20+ server; no npm dependencies. Put HTTPS in front of it.
const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

function createTelegramRelay({ apiKey, request = fetch }) {
  if (typeof apiKey !== "string" || apiKey.length < 32 || /\s/.test(apiKey)) {
    throw new Error(
      "TELEGRAM_RELAY_API_KEY must be at least 32 characters without whitespace",
    );
  }
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return http.createServer(
    { requestTimeout: 15000, headersTimeout: 10000 },
    async (req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(body));
      };
      const supplied = Buffer.from(req.headers.authorization || "");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        req.resume();
        return reply(401, {
          ok: false,
          error_code: 401,
          description: "Relay authentication required",
        });
      }
      // Fixed upstream and strict paths prevent arbitrary URL forwarding / SSRF.
      if (
        req.method !== "POST" ||
        !/^\/bot\d+:[A-Za-z0-9_-]+\/[A-Za-z][A-Za-z0-9]*$/.test(req.url || "")
      ) {
        req.resume();
        return reply(404, {
          ok: false,
          error_code: 404,
          description: "Unknown API route",
        });
      }
      if (
        req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      ) {
        req.resume();
        return reply(415, {
          ok: false,
          error_code: 415,
          description: "JSON requests only",
        });
      }
      let size = 0;
      const chunks = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            reply(413, {
              ok: false,
              error_code: 413,
              description: "Request too large",
            });
            return;
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          const data = JSON.parse(body);
          if (!data || typeof data !== "object" || Array.isArray(data))
            throw new Error();
        } catch {
          return reply(400, {
            ok: false,
            error_code: 400,
            description: "Invalid JSON object",
          });
        }
        const upstream = await request(`https://api.telegram.org${req.url}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        // Preserve Telegram's error_code and parameters.retry_after for the bot client.
        const result = await upstream.json();
        reply(upstream.status, result);
      } catch {
        // Errors can contain the bot token in their URL. Never log or return them.
        if (!res.headersSent && !res.destroyed) {
          reply(502, {
            ok: false,
            error_code: 502,
            description: "Telegram upstream unavailable",
          });
        }
      }
    },
  );
}

if (require.main === module) {
  const server = createTelegramRelay({
    apiKey: process.env.TELEGRAM_RELAY_API_KEY,
  });
  server.listen(
    Number(process.env.PORT) || 3020,
    process.env.HOST || "127.0.0.1",
    () => {
      console.log("Telegram relay listening");
    },
  );
  server.on("error", () => {
    console.error("Telegram relay could not start");
    process.exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { createTelegramRelay };
