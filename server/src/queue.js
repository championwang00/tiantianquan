import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { confirmBearWrite } from "./adapters/bear.js";
import { confirmEagleWrite, runEagleAdapter } from "./adapters/eagle.js";
import { runBearAdapter } from "./adapters/bear.js";
import { confirmObsidianWrite, runObsidianAdapter } from "./adapters/obsidian.js";
import { formatDateInShanghai, nowStampForId } from "./utils/time.js";

const tasks = new Map();
const taskRoot = path.join(os.homedir(), ".openclaw", "workspace", "clip-router", "tasks");

const adapters = {
  eagle: runEagleAdapter,
  bear: runBearAdapter,
  obsidian: runObsidianAdapter
};

export async function createTask(payload) {
  const task = {
    id: `clip_${nowStampForId()}_${Math.random().toString(36).slice(2, 7)}`,
    status: "queued",
    payload,
    results: Object.fromEntries(payload.targets.map((target) => [target, { status: "queued" }])),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  tasks.set(task.id, task);
  await appendTaskRecord(task);
  return task;
}

export async function runTask(task) {
  updateTask(task, { status: "running" });
  await appendTaskRecord(task);

  for (const target of task.payload.targets) {
    const adapter = adapters[target];
    task.results[target] = { status: "running" };
    await appendTaskRecord(task);

    try {
      task.results[target] = await adapter(task.payload);
    } catch (error) {
      task.results[target] = {
        status: "failed",
        reason: error.message || String(error)
      };
    }

    updateTask(task, { status: deriveStatus(task.results) });
    await appendTaskRecord(task);
  }

  updateTask(task, { status: deriveStatus(task.results) });
  await appendTaskRecord(task);
}

export async function getTask(id) {
  if (tasks.has(id)) return tasks.get(id);
  return findTaskInJsonl(id);
}

export async function confirmTaskBear(id, options = {}) {
  const normalized = typeof options === "string" ? { draft: options, includeScreenshot: true } : options;
  return confirmTaskTarget(id, "bear", (task) => confirmBearWrite(task, normalized));
}

export async function confirmTaskObsidian(id) {
  return confirmTaskTarget(id, "obsidian", confirmObsidianWrite);
}

export async function confirmTaskEagle(id, options = {}) {
  return confirmTaskTarget(id, "eagle", (task) => confirmEagleWrite(task, options));
}

export async function confirmTaskTarget(id, target, writer) {
  const task = await getTask(id);
  if (!task) return null;
  task.results[target] = { ...task.results[target], status: "running" };
  updateTask(task, { status: deriveStatus(task.results) });
  await appendTaskRecord(task);

  try {
    task.results[target] = await writer(task);
  } catch (error) {
    task.results[target] = {
      ...task.results[target],
      status: "failed",
      reason: error.message || String(error)
    };
  }

  updateTask(task, { status: deriveStatus(task.results) });
  await appendTaskRecord(task);
  return task;
}

function updateTask(task, patch) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  tasks.set(task.id, task);
}

function deriveStatus(results) {
  const statuses = Object.values(results).map((result) => result.status);
  if (statuses.some((status) => status === "running" || status === "queued")) return "running";
  if (statuses.every((status) => status === "success" || status === "exists")) return "success";
  if (statuses.some((status) => status === "needs_review")) return "needs_review";
  if (statuses.some((status) => status === "success" || status === "exists" || status === "needs_review")) {
    return "partial_success";
  }
  return "failed";
}

async function appendTaskRecord(task) {
  await fs.mkdir(taskRoot, { recursive: true });
  const date = formatDateInShanghai(new Date());
  const file = path.join(taskRoot, `${date}.jsonl`);
  await fs.appendFile(file, `${JSON.stringify(task)}\n`, "utf8");
}

async function findTaskInJsonl(id) {
  let files = [];
  try {
    files = await fs.readdir(taskRoot);
  } catch (_error) {
    return null;
  }

  const jsonlFiles = files.filter((file) => file.endsWith(".jsonl")).sort().reverse();
  for (const file of jsonlFiles) {
    const content = await fs.readFile(path.join(taskRoot, file), "utf8");
    const lines = content.trim().split("\n").reverse();
    for (const line of lines) {
      if (!line.includes(id)) continue;
      const task = JSON.parse(line);
      if (task.id === id) return task;
    }
  }

  return null;
}
