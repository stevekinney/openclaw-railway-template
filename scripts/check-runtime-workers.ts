import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type WorkerResult = { result: { status: "ok"; value: unknown[] } };
type WorkerPool = {
  run(input: unknown, options: { timeoutMs: number }): Promise<WorkerResult>;
  close(error?: Error): Promise<void>;
};
type WorkerPoolConstructor = new (options: {
  workerUrl: URL;
  workerClass: string;
  maxWorkers: number;
}) => WorkerPool;

export async function verifyHostLink(hostRoot = "/app"): Promise<void> {
  const host = await realpath(hostRoot);
  const link = path.join(hostRoot, "node_modules", "openclaw");
  if (!(await lstat(link)).isSymbolicLink() || await realpath(link) !== host) {
    throw new Error("Worker SDK imports must resolve to the exact packaged host");
  }
  const hostPackagePath = path.join(hostRoot, "package.json");
  const buildInfoPath = path.join(hostRoot, "dist", "build-info.json");
  const packageJson: unknown = JSON.parse(await readFile(hostPackagePath, "utf8"));
  const buildInfo: unknown = JSON.parse(await readFile(buildInfoPath, "utf8"));
  const packageVersion = readStringProperty(packageJson, "version");
  const buildVersion = readStringProperty(buildInfo, "version");
  if (readStringProperty(packageJson, "name") !== "openclaw") {
    throw new Error("host package name is not openclaw");
  }
  if (!packageVersion || !buildVersion || packageVersion !== buildVersion) {
    throw new Error(`host/build version mismatch: ${packageVersion ?? "missing"}/${buildVersion ?? "missing"}`);
  }
}

export function verifyWorkerResult(value: unknown): asserts value is WorkerResult {
  if (!isRecord(value) || !isRecord(value.result) || value.result.status !== "ok") {
    throw new Error("worker projection did not return status=ok");
  }
  if (!Array.isArray(value.result.value) || value.result.value.length !== 3) {
    throw new Error("worker projection did not return exactly three converted messages");
  }
  const [prompt, call, result] = value.result.value;
  if (!isRecord(prompt) || prompt.role !== "user" || !isRecord(call) || call.type !== "function_call" || call.call_id !== "diagnostic-call" || call.name !== "message" || !isRecord(result) || result.type !== "function_call_output" || result.call_id !== "diagnostic-call" || result.output !== "Synthetic result.") {
    throw new Error("worker projection lost the synthetic prompt or tool exchange");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function isWorkerPoolConstructor(value: unknown): value is WorkerPoolConstructor {
  return typeof value === "function";
}

function fixtureMessages() {
  return [
    {
      id: "user-1",
      role: "user",
      content: "Synthetic worker diagnostic.",
      timestamp: 1,
      __openclaw: { mirrorIdentity: "diagnostic-turn:prompt", upstreamUserText: "Synthetic worker diagnostic." },
    },
    {
      id: "assistant-1",
      parentId: "user-1",
      role: "assistant",
      content: [{ type: "toolCall", id: "diagnostic-call", name: "message", arguments: {} }],
      timestamp: 2,
      __openclaw: { mirrorIdentity: "diagnostic-turn:tool:diagnostic-call:call" },
    },
    {
      id: "tool-result-1",
      parentId: "assistant-1",
      role: "toolResult",
      toolCallId: "diagnostic-call",
      toolName: "message",
      content: [{ type: "text", text: "Synthetic result." }],
      timestamp: 3,
      __openclaw: { mirrorIdentity: "diagnostic-turn:tool:diagnostic-call:result" },
    },
  ];
}

export async function verifyRuntimeWorkers(hostRoot = "/app"): Promise<void> {
  await verifyHostLink(hostRoot);
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-worker-check-"));
  const environmentKeys = ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const;
  const previousEnvironment = environmentKeys.map((key) => process.env[key]);
  let pool: WorkerPool | undefined;
  try {
    process.env.OPENCLAW_HOME = workDirectory;
    process.env.OPENCLAW_STATE_DIR = path.join(workDirectory, "state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(workDirectory, "configuration.json");
    await writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}", { mode: 0o600 });
    const processRuntime: unknown = await import(pathToFileURL(path.join(hostRoot, "dist", "plugin-sdk", "process-runtime.js")).href);
    const WorkerTaskPool = isRecord(processRuntime) ? processRuntime.WorkerTaskPool : undefined;
    if (!isWorkerPoolConstructor(WorkerTaskPool)) throw new Error("process-runtime does not export WorkerTaskPool");
    const messages = fixtureMessages();
    const sessionFile = path.join(workDirectory, "session.jsonl");
    const sessionId = "codex-history-diagnostic";
    await writeFile(
      sessionFile,
      `${[
        { type: "session", version: 1, id: sessionId, timestamp: new Date().toISOString(), cwd: workDirectory },
        ...messages.map((message, index) => ({ type: "message", id: `diagnostic-${index}`, parentId: index === 0 ? null : `diagnostic-${index - 1}`, timestamp: new Date(index + 1).toISOString(), message })),
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    pool = new WorkerTaskPool({
      workerUrl: pathToFileURL(path.join(hostRoot, "dist", "extensions", "codex", "session-history.worker.js")),
      workerClass: "reader",
      maxWorkers: 1,
    });
    const result = await pool.run(
      {
        target: { kind: "file", sessionFile },
        sessionId,
        evidence: { mirroredMessages: messages, settledMessages: messages, turnId: "diagnostic-turn" },
      },
      { timeoutMs: 60_000 },
    );
    verifyWorkerResult(result);
    console.log(JSON.stringify({ ok: true, status: result.result.status, valueCount: result.result.value?.length }));
  } finally {
    try { await pool?.close(); } finally {
      for (const [index, key] of environmentKeys.entries()) {
        const value = previousEnvironment[index];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await verifyRuntimeWorkers(process.argv[2]);
