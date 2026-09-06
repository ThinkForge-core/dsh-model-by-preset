// dsh-model-by-preset host half.
//
// The model auto-map lives in the client bundle (client.js): a session's model
// follows its agent preset — per-preset "provider/model + reasoning effort"
// overrides configured in the /model-by-preset editor (empty = follow the
// global default). The system mechanism that persists a per-session pick as the
// global default is left intact (keeps the chip honest).
//
// This host half adds two tiny debug helpers for the client:
//   POST /api-ext/dsh-model-by-preset.debug        append one JSON line to
//                                                  $DSH_HOME/dsh-model-by-preset-debug.logl
//   POST /api-ext/dsh-model-by-preset.debug-clear  delete that log file
// so plugin behaviour can be inspected without a browser console.

import { appendFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-model-by-preset";

export const inject = ["webServer"];

function logPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-model-by-preset-debug.logl");
}

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (!webServer) return;
  // append one JSON line
  webServer.register({
    kind: "exact",
    path: "/api-ext/dsh-model-by-preset.debug",
    handler: async (req, res) => {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (body.length > 1 << 16) break;
      }
      try {
        const payload = JSON.parse(body);
        const line = {
          time: new Date().toISOString(),
          ...(typeof payload === "object" && payload !== null ? payload : { note: String(payload) })
        };
        await appendFile(logPath(), JSON.stringify(line) + "\n", "utf8");
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    }
  });
  // delete the log file (missing file is not an error)
  webServer.register({
    kind: "exact",
    path: "/api-ext/dsh-model-by-preset.debug-clear",
    handler: async (_req, res) => {
      try {
        await rm(logPath(), { force: true });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    }
  });
  ctx.logger.info("dsh-model-by-preset: debug sink ready at /api-ext/dsh-model-by-preset.debug");
}
