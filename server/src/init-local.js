import { ensureLocalRouterToken, loadEnv } from "./utils/env.js";

ensureLocalRouterToken(loadEnv());
console.log("Local router token is ready.");
