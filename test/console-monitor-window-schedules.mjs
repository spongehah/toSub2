import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-monitor-windows-"));
const clockPath = path.join(outputRoot, "clock.txt");
const clockImportPath = path.join(outputRoot, "clock.mjs");
const monitorPath = path.join(outputRoot, "sub2api-monitor.json");
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
let remoteAccounts = [];
let advanceClockOnFetch = null;
let child;
let childExit;
let apiKey = "";
let logs = "";

const sub2api = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    assert.equal(req.headers["x-api-key"], "test-admin-key");
    assert.equal(req.method, "GET");
    assert.equal(url.pathname, "/api/v1/admin/accounts");
    assert.equal(url.searchParams.get("status"), "error");
    if (advanceClockOnFetch !== null) {
      await setClock(advanceClockOnFetch);
      advanceClockOnFetch = null;
    }
    send(res, 200, { data: { items: remoteAccounts, pages: 1, total: remoteAccounts.length } });
  } catch (error) {
    send(res, 500, { message: error.message });
  }
});
await new Promise((resolve) => sub2api.listen(0, "127.0.0.1", resolve));
const config = { baseUrl: `http://127.0.0.1:${sub2api.address().port}`, adminApiKey: "test-admin-key" };

// Keep the server's wall clock deterministic without changing production code or host timezone.
await fs.writeFile(clockImportPath, `
import fs from "node:fs";
const OriginalDate = Date;
const clockNow = () => Number(fs.readFileSync(process.env.MONITOR_TEST_CLOCK_PATH, "utf8"));
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [clockNow()])); }
  static now() { return clockNow(); }
};
`);

try {
  await setClock("2026-11-25T12:00:00+08:00");
  await startConsole();

  // Persisted legacy fixed windows must still load when no schedule field exists.
  await saveConfig({ planMonitorWindows: "default=2\nplus=6" }, false);
  await stopConsole();
  const legacy = JSON.parse(await fs.readFile(monitorPath, "utf8"));
  delete legacy.config.planMonitorWindowSchedules;
  await fs.writeFile(monitorPath, JSON.stringify(legacy));
  await startConsole();
  const legacyState = (await api("/api/sub2api/monitor")).body;
  assert.equal(legacyState.configured, true);
  assert.deepEqual(legacyState.planMonitorWindows, { default: 2, plus: 6 });
  assert.deepEqual(legacyState.planMonitorWindowSchedules, []);

  const schedules = "DEFAULT@08:00-20:00=12\ndefault@20:00-08:00=24\nPLUS@20:00-08:00=1";
  const saved = await saveConfig({ planMonitorWindows: "default=2\nplus=6", planMonitorWindowSchedules: schedules }, false);
  const normalized = [
    { planType: "default", start: "08:00", end: "20:00", hours: 12 },
    { planType: "default", start: "20:00", end: "08:00", hours: 24 },
    { planType: "plus", start: "20:00", end: "08:00", hours: 1 },
  ];
  assert.deepEqual(saved.planMonitorWindowSchedules, normalized);
  const persisted = JSON.parse(await fs.readFile(monitorPath, "utf8"));
  assert.deepEqual(persisted.config.planMonitorWindowSchedules, normalized);
  await stopConsole();
  await startConsole();
  const restored = (await api("/api/sub2api/monitor")).body;
  assert.equal(restored.configured, true);
  assert.deepEqual(restored.planMonitorWindows, { default: 2, plus: 6 });
  assert.deepEqual(restored.planMonitorWindowSchedules, normalized);

  const invalidSchedules = [
    "default@24:00-08:00=12", "default@8:00-20:00=12", "default@08:60-20:00=12",
    "default@08:00:00-20:00=12", "default@08:00-08:00=12", "default@08:00-20:00=0",
    "default@08:00-20:00=8761", "default@08:00-20:00=1.5", "default@08:00-20:00=-1",
    "bad.plan@08:00-20:00=12", "default=12", "default@08:00-20:00=12 trailing",
    "default@08:00-20:00=12\nDEFAULT@19:00-22:00=24",
    "default@20:00-08:00=12\ndefault@07:00-09:00=24",
    "default@20:00-08:00=12\ndefault@23:00-01:00=24",
    "default@20:00-08:00=12\ndefault@20:00-08:00=24",
    [{ planType: "default", start: "08:00", end: "08:00", hours: 12 }],
    [{ planType: "default", start: "08:00", end: "20:00", hours: 0 }],
    [{ planType: "default", start: "08:00", end: "20:00" }],
    { default: 12 },
  ];
  for (const value of invalidSchedules) {
    const result = await api("/api/sub2api/monitor", "POST", { enabled: false, config: { ...config, planMonitorWindowSchedules: value } });
    assert.equal(result.status, 400, `invalid schedule accepted: ${JSON.stringify(value)}; ${JSON.stringify(result.body)}`);
  }
  assert.deepEqual((await api("/api/sub2api/monitor")).body.planMonitorWindowSchedules, normalized, "invalid edits must preserve saved config");

  // Adjacent ranges and overlapping ranges for different plans are valid.
  await saveConfig({ planMonitorWindows: "default=2\nplus=6", planMonitorWindowSchedules: normalized });
  for (const [time, planType, ageHours, included, label] of [
    ["07:59:59", "pro", 13, true, "night before day start"],
    ["08:00:00", "pro", 13, false, "day start is inclusive"],
    ["19:59:59", "pro", 13, false, "day before night start"],
    ["20:00:00", "pro", 13, true, "day end is exclusive"],
    ["00:00:00", "pro", 13, true, "cross-midnight night schedule"],
    ["12:00:00", "PLUS", 7, false, "plan fixed window precedes default schedule"],
    ["12:00:00", "plus", 6, true, "fixed age boundary is inclusive"],
    ["23:00:00", "plus", 2, false, "plan schedule precedes plan fixed window"],
    ["23:00:00", "plus", 1, true, "scheduled age boundary is inclusive"],
    ["12:00:00", "pro", 12, true, "default schedule precedes default fixed window"],
    ["12:00:00", "", 13, false, "missing plan uses default schedule"],
    ["12:00:00", "pro", -1, false, "future creation is outside a bounded window"],
    ["12:00:00", "pro", NaN, false, "invalid creation is outside a bounded window"],
  ]) {
    await checkAccount({ now: `2026-11-25T${time}+08:00`, planType, ageHours, included, label });
  }
  // A single millisecond past the age limit is excluded.
  await checkAccount({ now: "2026-11-25T12:00:00+08:00", planType: "pro", ageHours: 12 + 1 / 3_600_000, included: false, label: "past age boundary" });

  await saveConfig({ planMonitorWindows: "default=2\nplus=6", planMonitorWindowSchedules: "default@08:00-20:00=12" });
  await checkAccount({ now: "2026-11-25T23:00:00+08:00", planType: "pro", ageHours: 3, included: false, label: "default fixed fallback outside schedule" });
  await checkAccount({ now: "2026-11-25T23:00:00+08:00", planType: "plus", ageHours: 5, included: true, label: "plan fixed fallback outside schedule" });
  await saveConfig({ planMonitorWindowSchedules: "plus@08:00-20:00=1" });
  await checkAccount({ now: "2026-11-25T23:00:00+08:00", planType: "plus", ageHours: NaN, included: true, label: "unrestricted when no fixed or active scheduled window" });
  await saveConfig({});
  await checkAccount({ now: "2026-11-25T12:00:00+08:00", planType: "pro", ageHours: 10000, included: true, label: "legacy empty windows remain unrestricted" });

  // Crossing a boundary while fetching accounts must not mix time policies or ages in one round.
  await saveConfig({ planMonitorWindowSchedules: "default@08:00-20:00=1\ndefault@20:00-08:00=24" });
  const roundStart = Date.parse("2026-11-25T19:59:59+08:00");
  await setClock(roundStart);
  remoteAccounts = [account(1, "pro", roundStart - 2 * 3_600_000), account(2, "pro", roundStart - 3_600_000)];
  advanceClockOnFetch = "2026-11-25T20:00:01+08:00";
  const crossing = await api("/api/sub2api/monitor/check", "POST");
  assert.equal(crossing.status, 200, JSON.stringify(crossing.body));
  assert.equal(crossing.body.result.outsideWindow, 1, "the round keeps its daytime policy");
  assert.equal(crossing.body.result.missingTask, 1, "the age boundary uses the same captured time");
  console.log("console monitor window schedule tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  await stopConsole();
  sub2api.closeAllConnections();
  await new Promise((resolve) => sub2api.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function saveConfig(windows, enabled = true) {
  const result = await api("/api/sub2api/monitor", "POST", { enabled, config: { ...config, ...windows } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function checkAccount({ now, planType, ageHours, included, label }) {
  await setClock(now);
  remoteAccounts = [account(1, planType, Date.parse(now) - ageHours * 3_600_000)];
  const result = await api("/api/sub2api/monitor/check", "POST");
  assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.result.checked, 1, label);
  assert.equal(result.body.result.outsideWindow, included ? 0 : 1, label);
  assert.equal(result.body.result.missingTask, included ? 1 : 0, label);
  assert.equal(result.body.result.started, 0, "these fixtures have no local login tasks");
}

function account(id, planType, createdAt) {
  return {
    id, platform: "openai", type: "oauth", status: "error", name: `missing-${id}@example.com`,
    created_at: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : "invalid-date",
    credentials: { email: `missing-${id}@example.com`, plan_type: planType },
  };
}

async function setClock(value) {
  await fs.writeFile(clockPath, String(typeof value === "number" ? value : Date.parse(value)));
}

async function startConsole() {
  child = spawn(process.execPath, ["--import", pathToFileURL(clockImportPath).href, path.join(projectRoot, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(port), "--console-password", "schedule-test-password"], {
    cwd: projectRoot,
    env: { ...process.env, ONBOARDING_OUTPUT_ROOT: outputRoot, MONITOR_TEST_CLOCK_PATH: clockPath, SUB2API_MONITOR_INTERVAL_MS: "3600000", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { logs = `${logs}${value}`.slice(-20_000); });
  child.stderr.on("data", (value) => { logs = `${logs}${value}`.slice(-20_000); });
  childExit = new Promise((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/bootstrap`, { signal: AbortSignal.timeout(1_000) })).ok) {
        apiKey = JSON.parse(await fs.readFile(path.join(outputRoot, "console-api-key.json"), "utf8")).apiKey;
        return;
      }
    } catch {}
    await delay(40);
  }
  throw new Error("console startup timed out");
}

async function stopConsole() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([childExit, delay(2_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await childExit;
  }
}

async function api(endpoint, method = "GET", body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method, headers: { "content-type": "application/json", "x-api-key": apiKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

function send(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
