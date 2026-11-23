import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-manual-input-retry-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-queue-protocol.mjs"),
    TOSUB2_TLS_PROFILE: "chrome142",
    INPUT_WAIT_TIMEOUT_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let consoleLogs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "manual-retry@example.com" }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 201, responseBody);
  const { job: created } = JSON.parse(responseBody);

  // The first true manual prompt safely restarts; the second one waits for the normal timeout.
  const retried = await waitForJob(headers, created.id, (job) => job.attempt === 2 && job.status === "email_otp");
  assert.equal(retried.manualInputAutoRetryCount, 1);
  const canceled = await waitForJob(headers, created.id, (job) => job.status === "canceled");
  assert.equal(canceled.attempt, 2);
  assert.match(canceled.lastError || "", /等待输入超过/);
  const logs = await (await fetch(`${baseUrl}/api/jobs/${created.id}/logs`, { headers })).json();
  assert.equal(countOccurrences(logs.logs, "Mock queued login started"), 2);
  assert.match(logs.logs, /首次需要手动输入 email_otp/);
  console.log("console manual input retry tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${consoleLogs}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited before startup with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`console did not start at ${url}`);
}

async function waitForJob(headers, jobId, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    if (job && predicate(job)) return job;
    await delay(50);
  }
  throw new Error(`job ${jobId} did not reach the expected state`);
}

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port: availablePort } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return availablePort;
}

function countOccurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
