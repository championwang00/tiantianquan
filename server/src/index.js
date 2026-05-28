import http from "node:http";
import { createRouter } from "./router.js";
import { ensureLocalRouterToken, loadEnv } from "./utils/env.js";

const env = ensureLocalRouterToken(loadEnv());
const port = Number(env.CLIP_ROUTER_PORT || 18791);
const host = "127.0.0.1";

const server = http.createServer(createRouter(env));

server.listen(port, host, () => {
  console.log(`甜甜圈 listening at http://${host}:${port}`);
});
