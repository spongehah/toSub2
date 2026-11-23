import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-relogin-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const requests = [];
const remoteAccounts = new Map();
const failClearOnce = new Set();
const failPutOnce = new Set();
let releaseApply = null;
let blockedApplyId = null;
let child;
let childExit;
let logs = "";
let apiKey = "";

for (const [id, email] of [[101, "explicit@example.com"], [202, "search@example.com"], [201, "search@example.com"], [303, "resend@example.com"], [404, "mfa-prompt@example.com"], [505, "queued@example.com"], [606, "info-error@example.com"], [607, "info-inactive@example.com"], [608, "info-resend@example.com"], [609, "info-search@example.com"]]) {
  remoteAccounts.set(id, {
    id,
    name: `oauth---${email}`,
    platform: "openai",
    type: "oauth",
    created_at: id === 201 ? "2026-01-01T00:00:00Z" : "2026-11-23T00:00:00Z",
    status: id === 607 ? "inactive" : "error",
    schedulable: false,
    error_message: "original remote error",
    credentials: { email, chatgpt_account_id: `test-account-${email}`, custom_credential: "preserve-credential" },
    extra: { custom_setting: "preserve-me", codex_fingerprint_mode: "device" },
  });
}

const sub2api = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (req.headers["x-api-key"] !== "test-admin-key") return send(res, 401, { message: "invalid admin key" });
    if (req.method === "GET" && url.pathname === "/api/v1/admin/accounts") {
      const email = url.searchParams.get("search");
      if (email === "lookup-error@example.com") return send(res, 503, { message: "lookup unavailable" });
      const items = email ? [...remoteAccounts.values()]
        .filter((account) => account.name.includes(email))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
      return send(res, 200, { data: { items, total: items.length, page: 1, page_size: 1, pages: 1 } });
    }
    const detailMatch = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
    if (detailMatch && ["GET", "PUT"].includes(req.method)) {
      const id = Number(detailMatch[1]);
      const account = remoteAccounts.get(id);
      if (!account) return send(res, 404, { message: "remote account not found" });
      if (req.method === "PUT") {
        if (failPutOnce.delete(id)) return send(res, 500, { message: "simulated information update failure" });
        Object.assign(account, body);
      }
      return send(res, 200, { data: account });
    }
    const match = /^\/api\/v1\/admin\/accounts\/(\d+)\/(apply-oauth-credentials|clear-error|schedulable)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) return send(res, 404, { message: "unexpected remote request" });
    const id = Number(match[1]);
    const account = remoteAccounts.get(id);
    if (!account) return send(res, 404, { message: "remote account not found" });
    if (match[2] === "apply-oauth-credentials") {
      if (id === blockedApplyId) await new Promise((resolve) => { releaseApply = resolve; });
      account.credentials = { ...account.credentials, ...body.credentials };
      account.extra = { ...account.extra, ...body.extra };
    } else if (match[2] === "clear-error") {
      if (failClearOnce.delete(id)) return send(res, 500, { message: "simulated clear-error failure" });
      account.status = "active";
    } else {
      account.schedulable = body.schedulable;
    }
    send(res, 200, { data: account });
  } catch (error) {
    send(res, 500, { message: error.message });
  }
});
await new Promise((resolve) => sub2api.listen(0, "127.0.0.1", resolve));
const sub2apiUrl = `http://127.0.0.1:${sub2api.address().port}`;
const protocolPath = path.join(outputRoot, "mock-relogin-protocol.mjs");

// Blockers exercise the real queue; all authorization results use the shared protocol fixture.
await fs.writeFile(protocolPath, `
const email = process.argv[process.argv.indexOf("--email") + 1];
if (email.startsWith("blocker-")) {
  console.log("[1/5] Mock queue blocker started");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
} else {
  await import(${JSON.stringify(new URL("./mock-protocol-login.mjs", import.meta.url).href)});
}
`);

try {
  await startConsole();
  const unauthorized = await fetch(`${baseUrl}/api/sub2api/relogin/status?email=explicit@example.com`);
  assert.equal(unauthorized.status, 401);
  const invalidKey = await fetch(`${baseUrl}/api/sub2api/relogin/status?email=explicit@example.com`, { headers: { "x-api-key": "invalid-key" } });
  assert.equal(invalidKey.status, 401);

  for (const body of [{}, { email: "not-an-email" }, ...[0, -1, 1.5, "101", null, Number.MAX_SAFE_INTEGER + 1].map((sub2apiAccountId) => ({ email: "explicit@example.com", sub2apiAccountId }))]) {
    const result = await api("/api/sub2api/relogin", "POST", body);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.started, false);
    assert.equal(typeof result.body.code, "string");
  }
  const missing = await api("/api/sub2api/relogin", "POST", { email: "missing@example.com" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.accountExists, false);
  assert.equal(missing.body.started, false);
  const missingStatus = await status("missing@example.com");
  assert.equal(missingStatus.status, 404);
  assert.equal(missingStatus.body.accountExists, false);

  const explicit = await createCompleted("explicit@example.com");
  const initialStatus = await status("explicit@example.com", true);
  assert.equal(initialStatus.status, 200);
  assert.equal(initialStatus.body.operation, null);
  assert.equal(initialStatus.body.accountExists, true);
  assert.equal(initialStatus.body.status, "completed");
  const notConfigured = await api("/api/sub2api/relogin", "POST", { email: explicit.email, sub2apiAccountId: 101 });
  assert.equal(notConfigured.status, 409);
  assert.equal(notConfigured.body.started, false);
  assert.equal(notConfigured.body.accountExists, true);
  assert.equal(requests.length, 0);

  const config = {
    baseUrl: sub2apiUrl,
    adminApiKey: "test-admin-key",
    groupIds: [777],
    codexFingerprintMode: "full",
  };
  const configured = await api("/api/sub2api/monitor", "POST", { enabled: false, config });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  for (const restoreState of [null, "false", 0, 1, {}, []]) {
    const invalidRestoreState = await api("/api/sub2api/relogin", "POST", { email: explicit.email, sub2apiAccountId: 101, restoreState });
    assert.equal(invalidRestoreState.status, 400, JSON.stringify(invalidRestoreState.body));
    assert.equal(invalidRestoreState.body.code, "INVALID_RESTORE_STATE");
    assert.equal(invalidRestoreState.body.started, false);
  }

  // A supplied target never requires either account-list or account-detail lookup.
  blockedApplyId = 101;
  const explicitStart = await api("/api/sub2api/relogin", "POST", { email: " EXPLICIT@EXAMPLE.COM ", sub2apiAccountId: 101 });
  assert.equal(explicitStart.status, 202, JSON.stringify(explicitStart.body));
  assert.equal(explicitStart.body.started, true);
  assert.equal(explicitStart.body.email, explicit.email);
  assert.equal(explicitStart.body.operation.sub2apiAccountId, 101);
  assert.equal(explicitStart.body.operation.restoreState, true, "state recovery remains the default");
  const updating = await waitForStatus(explicit.email, (value) => value.operation?.updateStatus === "updating");
  assert.equal(updating.status, "completed", "login completion must be distinct from remote update completion");
  assert.equal(updating.operation.phase, "updating");
  assert.equal(requests.some((request) => request.method === "GET"), false);
  const duplicate = await api("/api/sub2api/relogin", "POST", { email: explicit.email, sub2apiAccountId: 101 });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.started, false);
  assert.equal(duplicate.body.operation.id, explicitStart.body.operation.id);
  releaseApply();
  releaseApply = null;
  blockedApplyId = null;
  const completed = await waitForStatus(explicit.email, (value) => value.operation?.updateStatus === "succeeded");
  assert.equal(completed.operation.phase, "completed");
  assert.equal(completed.operation.id, explicitStart.body.operation.id);
  assert.equal(completed.operation.sub2apiAccountId, 101);
  assert.equal(completed.operation.restoreState, true);
  assert.equal(completed.operation.error, null);
  assert.equal(typeof completed.operation.completedAt, "string");
  assertSafeStatus(completed);
  assert.deepEqual(remoteAccounts.get(101).extra, { custom_setting: "preserve-me", codex_fingerprint_mode: "full" });
  assert.deepEqual(requests.map((request) => [request.method, request.pathname]), [
    ["POST", "/api/v1/admin/accounts/101/apply-oauth-credentials"],
    ["POST", "/api/v1/admin/accounts/101/clear-error"],
    ["POST", "/api/v1/admin/accounts/101/schedulable"],
  ]);
  assert.deepEqual(requests[0].body.extra, { codex_fingerprint_mode: "full" });
  assert.equal(requests[0].body.type, "oauth");
  assert.equal(requests[0].body.credentials.email, explicit.email);
  assert.equal(requests[2].body.schedulable, true);

  // The lookup is a single server-filtered request; only the first/newest result is updated.
  await createCompleted("search@example.com");
  requests.length = 0;
  const searched = await api("/api/sub2api/relogin", "POST", { email: "search@example.com" });
  assert.equal(searched.status, 202, JSON.stringify(searched.body));
  assert.equal(searched.body.operation.sub2apiAccountId, 202);
  await waitForStatus("search@example.com", (value) => value.operation?.updateStatus === "succeeded");
  assert.deepEqual(requests[0].query, {
    search: "search@example.com", platform: "openai", type: "oauth", page: "1", page_size: "1", sort_by: "created_at", sort_order: "desc",
  });
  assert.equal(requests.filter((request) => request.method === "GET").length, 1);
  assert.equal(requests.some((request) => request.pathname.includes("/201/")), false);
  assert.equal(remoteAccounts.get(201).status, "error");

  for (const [email, expectedStatus] of [["remote-missing@example.com", 404], ["lookup-error@example.com", 502]]) {
    const local = await createCompleted(email);
    const before = (await status(email)).body.attempt;
    const result = await api("/api/sub2api/relogin", "POST", { email });
    assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    assert.equal(result.body.started, false);
    assert.equal(result.body.accountExists, true);
    assert.equal((await status(email)).body.attempt, before, "lookup failure must not start another login");
    assert.equal(local.email, email);
  }

  // Filling the existing concurrency limit verifies queued state and admission locking.
  const queued = await createCompleted("queued@example.com");
  const blockers = await Promise.all(Array.from({ length: 20 }, (_, i) => api("/api/jobs", "POST", { email: `blocker-${i}@example.com` })));
  const blockerIds = blockers.map((result) => {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.job.id;
  });
  await waitFor(async () => {
    const page = await api("/api/jobs");
    return page.body.jobs.filter((job) => job.email.startsWith("blocker-") && job.status !== "queued").length === 20;
  });
  const queuedStart = await api("/api/sub2api/relogin", "POST", { email: queued.email, sub2apiAccountId: 505 });
  assert.equal(queuedStart.status, 202);
  const queuedStatus = (await status(queued.email)).body;
  assert.equal(queuedStatus.status, "queued");
  assert.ok(queuedStatus.queuePosition >= 1);
  assert.equal(queuedStatus.operation.updateStatus, "pending");
  const queuedDuplicate = await api("/api/sub2api/relogin", "POST", { email: queued.email, sub2apiAccountId: 505 });
  assert.equal(queuedDuplicate.status, 409);
  // Canceling before launch must release the repair context and allow a new operation.
  const canceledQueued = await api(`/api/jobs/${queued.id}/cancel`, "POST", {});
  assert.equal(canceledQueued.status, 200, JSON.stringify(canceledQueued.body));
  const canceledQueuedStatus = (await status(queued.email)).body;
  assert.equal(canceledQueuedStatus.status, "canceled");
  assert.equal(canceledQueuedStatus.operation.phase, "canceled");
  assert.equal(canceledQueuedStatus.operation.updateStatus, "not_started");
  const restartedQueued = await api("/api/sub2api/relogin", "POST", { email: queued.email, sub2apiAccountId: 505 });
  assert.equal(restartedQueued.status, 202, JSON.stringify(restartedQueued.body));
  assert.notEqual(restartedQueued.body.operation.id, queuedStart.body.operation.id);
  assert.equal(restartedQueued.body.status, "queued");
  await Promise.all(blockerIds.map((id) => api(`/api/jobs/${id}/cancel`, "POST", {})));
  const queuedCompleted = await waitForStatus(queued.email, (value) => value.operation?.updateStatus === "succeeded");
  assert.equal(queuedCompleted.operation.id, restartedQueued.body.operation.id);

  // Existing interactive controls remain usable after the automatic one-time restart.
  const mfa = await api("/api/jobs", "POST", { email: "mfa-prompt@example.com" });
  assert.equal(mfa.status, 201);
  await waitForStatus("mfa-prompt@example.com", (value) => value.status === "mfa_otp" && value.manualInputAutoRetryCount === 1);
  await api(`/api/jobs/${mfa.body.job.id}/cancel`, "POST", {});
  const interactive = await api("/api/sub2api/relogin", "POST", { email: "mfa-prompt@example.com", sub2apiAccountId: 404 });
  assert.equal(interactive.status, 202);
  const waiting = await waitForStatus("mfa-prompt@example.com", (value) => value.status === "mfa_otp" && value.manualInputAutoRetryCount === 1);
  assert.equal(waiting.requiresInput, true);
  assert.equal(waiting.inputType, "mfa_otp");
  assert.equal(waiting.operation.updateStatus, "pending");
  const entered = await api(`/api/jobs/${mfa.body.job.id}/input`, "POST", { action: "mfa_otp", value: "123456" });
  assert.equal(entered.status, 200, JSON.stringify(entered.body));
  await waitForStatus("mfa-prompt@example.com", (value) => value.operation?.updateStatus === "succeeded");

  // Information-only updates must never activate accounts or change their scheduling switch.
  for (const [id, email] of [[606, "info-error@example.com"], [607, "info-inactive@example.com"]]) {
    await createCompleted(email);
    const original = structuredClone(remoteAccounts.get(id));
    requests.length = 0;
    const informationStart = await api("/api/sub2api/relogin", "POST", { email, sub2apiAccountId: id, restoreState: false });
    assert.equal(informationStart.status, 202, JSON.stringify(informationStart.body));
    assert.equal(informationStart.body.operation.restoreState, false);
    const informationDone = await waitForStatus(email, (value) => value.operation?.updateStatus === "succeeded");
    assert.equal(informationDone.operation.restoreState, false);
    assert.equal(informationDone.operation.phase, "completed");
    const remote = remoteAccounts.get(id);
    assert.equal(remote.status, original.status);
    assert.equal(remote.schedulable, false);
    assert.equal(remote.error_message, original.error_message);
    assert.equal(remote.credentials.custom_credential, "preserve-credential");
    assert.equal(remote.credentials.access_token, `test-access-${email}`);
    assert.deepEqual(remote.extra, { custom_setting: "preserve-me", codex_fingerprint_mode: "full" });
    assert.deepEqual(requests.map((request) => [request.method, request.pathname]), [
      ["GET", `/api/v1/admin/accounts/${id}`],
      ["PUT", `/api/v1/admin/accounts/${id}`],
    ]);
    assert.deepEqual(Object.keys(requests[1].body).sort(), ["credentials", "extra"]);
    assert.equal(requests[1].body.credentials.custom_credential, "preserve-credential");
    assert.equal(requests[1].body.extra.custom_setting, "preserve-me");
  }

  // A supplied ID belonging to another email must not overwrite that account's credentials.
  await createCompleted("wrong-target@example.com");
  const wrongTargetBefore = structuredClone(remoteAccounts.get(606));
  requests.length = 0;
  const wrongTarget = await api("/api/sub2api/relogin", "POST", { email: "wrong-target@example.com", sub2apiAccountId: 606, restoreState: false });
  assert.equal(wrongTarget.status, 202, JSON.stringify(wrongTarget.body));
  const wrongTargetFailed = await waitForStatus("wrong-target@example.com", (value) => value.operation?.updateStatus === "failed");
  assert.equal(wrongTargetFailed.status, "completed");
  assert.equal(wrongTargetFailed.operation.phase, "failed");
  assert.equal(wrongTargetFailed.operation.restoreState, false);
  assert.deepEqual(requests.map((request) => [request.method, request.pathname]), [["GET", "/api/v1/admin/accounts/606"]]);
  assert.deepEqual(remoteAccounts.get(606), wrongTargetBefore);

  // Omitting the target ID keeps the same server-filtered lookup for information-only updates.
  await createCompleted("info-search@example.com");
  requests.length = 0;
  const informationSearch = await api("/api/sub2api/relogin", "POST", { email: "info-search@example.com", restoreState: false });
  assert.equal(informationSearch.status, 202, JSON.stringify(informationSearch.body));
  assert.equal(informationSearch.body.operation.sub2apiAccountId, 609);
  assert.equal(informationSearch.body.operation.restoreState, false);
  await waitForStatus("info-search@example.com", (value) => value.operation?.updateStatus === "succeeded");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].query.search, "info-search@example.com");
  assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
  assert.equal(requests.some((request) => request.method === "POST"), false);
  assert.equal(remoteAccounts.get(609).status, "error");
  assert.equal(remoteAccounts.get(609).schedulable, false);
  assert.equal(remoteAccounts.get(609).error_message, "original remote error");

  // Failed information-only writes retain the selected behavior across restart and pending resend.
  await createCompleted("info-resend@example.com");
  failPutOnce.add(608);
  const informationResend = await api("/api/sub2api/relogin", "POST", { email: "info-resend@example.com", sub2apiAccountId: 608, restoreState: false });
  assert.equal(informationResend.status, 202);
  const informationFailed = await waitForStatus("info-resend@example.com", (value) => value.operation?.updateStatus === "failed");
  assert.equal(informationFailed.status, "completed");
  assert.equal(informationFailed.operation.restoreState, false);
  assert.equal(informationFailed.operation.phase, "failed");
  const informationAttempt = informationFailed.attempt;
  const informationOperationId = informationFailed.operation.id;

  // A failed remote cleanup survives restart and later retries only the remote update.
  await createCompleted("resend@example.com");
  failClearOnce.add(303);
  const resend = await api("/api/sub2api/relogin", "POST", { email: "resend@example.com", sub2apiAccountId: 303 });
  assert.equal(resend.status, 202);
  const failed = await waitForStatus("resend@example.com", (value) => value.operation?.updateStatus === "failed");
  assert.equal(failed.status, "completed");
  assert.equal(failed.operation.phase, "failed");
  assert.match(failed.operation.error, /HTTP 500/);
  const attempt = failed.attempt;
  const operationId = failed.operation.id;
  await stopConsole();
  await startConsole();
  const restored = (await status("resend@example.com")).body;
  assert.equal(restored.operation.id, operationId);
  assert.equal(restored.operation.phase, "failed");
  assert.equal(restored.operation.updateStatus, "failed");
  assert.equal(restored.operation.restoreState, true);
  const informationRestored = (await status("info-resend@example.com")).body;
  assert.equal(informationRestored.operation.id, informationOperationId);
  assert.equal(informationRestored.operation.restoreState, false);
  assert.equal(informationRestored.operation.updateStatus, "failed");
  requests.length = 0;
  const enabled = await api("/api/sub2api/monitor", "POST", { enabled: true, config });
  assert.equal(enabled.status, 200);
  const checked = await api("/api/sub2api/monitor/check", "POST", {});
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const resent = await waitForStatus("resend@example.com", (value) => value.operation?.updateStatus === "succeeded");
  assert.equal(resent.attempt, attempt, "pending remote resend must not rerun login");
  assert.equal(resent.operation.id, operationId);
  assert.equal(resent.operation.sub2apiAccountId, 303);
  assert.equal(requests.some((request) => request.method === "PUT" && request.pathname === "/api/v1/admin/accounts/303"), false);
  assert.equal(requests.some((request) => request.pathname === "/api/v1/admin/accounts/303"), false);
  assert.equal(requests.filter((request) => request.pathname === "/api/v1/admin/accounts/303/apply-oauth-credentials").length, 1);
  const informationResent = await waitForStatus("info-resend@example.com", (value) => value.operation?.updateStatus === "succeeded");
  assert.equal(informationResent.attempt, informationAttempt, "information resend must not rerun login");
  assert.equal(informationResent.operation.id, informationOperationId);
  assert.equal(informationResent.operation.restoreState, false);
  assert.equal(informationResent.operation.sub2apiAccountId, 608);
  const informationRequests = requests.filter((request) => request.pathname.startsWith("/api/v1/admin/accounts/608"));
  assert.deepEqual(informationRequests.map((request) => [request.method, request.pathname]), [
    ["GET", "/api/v1/admin/accounts/608"],
    ["PUT", "/api/v1/admin/accounts/608"],
  ]);
  assert.equal(remoteAccounts.get(608).status, "error");
  assert.equal(remoteAccounts.get(608).schedulable, false);
  assert.equal(remoteAccounts.get(608).error_message, "original remote error");
  assert.equal(remoteAccounts.get(608).credentials.custom_credential, "preserve-credential");
  assert.deepEqual(remoteAccounts.get(608).extra, { custom_setting: "preserve-me", codex_fingerprint_mode: "full" });
  console.log("console sub2api relogin tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  releaseApply?.();
  await stopConsole();
  sub2api.closeAllConnections();
  await new Promise((resolve) => sub2api.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function startConsole() {
  child = spawn(process.execPath, [
    path.join(projectRoot, "src", "console-server.mjs"),
    "--host", "127.0.0.1", "--port", String(port),
    "--console-password", "integration-console-password",
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ONBOARDING_OUTPUT_ROOT: outputRoot,
      ONBOARDING_PROTOCOL_SCRIPT: protocolPath,
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
      TOSUB2_TLS_PROFILE: "chrome142",
      SUB2API_MONITOR_INTERVAL_MS: "3600000",
      SUB2API_AUTO_REPAIR_COOLDOWN_MS: "0",
      INPUT_WAIT_TIMEOUT_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { logs = `${logs}${value}`.slice(-20_000); });
  child.stderr.on("data", (value) => { logs = `${logs}${value}`.slice(-20_000); });
  childExit = new Promise((resolve) => child.once("exit", resolve));
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`console exited with code ${child.exitCode}`);
    try { return (await fetch(`${baseUrl}/api/bootstrap`)).ok; } catch { return false; }
  });
  apiKey = JSON.parse(await fs.readFile(path.join(outputRoot, "console-api-key.json"), "utf8")).apiKey;
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

async function api(endpoint, method = "GET", body, bearer = false) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function status(email, bearer = false) {
  return api(`/api/sub2api/relogin/status?email=${encodeURIComponent(email)}`, "GET", undefined, bearer);
}

async function createCompleted(email) {
  const result = await api("/api/jobs", "POST", { email, password: "integration-secret-password" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  await waitForStatus(email, (value) => value.status === "completed");
  return result.body.job;
}

async function waitForStatus(email, predicate) {
  let latest;
  await waitFor(async () => {
    const result = await status(email);
    latest = result.body;
    return result.status === 200 && predicate(result.body);
  }, () => `status not reached for ${email}: ${JSON.stringify(latest)}`);
  return latest;
}

async function waitFor(predicate, message = () => "condition timed out") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error(message());
}

function assertSafeStatus(value) {
  const serialized = JSON.stringify(value);
  for (const secret of ["access_token", "refresh_token", "id_token", "totpSetupSecret", "totpSetupUri", "mailApiUrl", "integration-secret-password", "test-admin-key"]) {
    assert.equal(serialized.includes(secret), false, `status exposed ${secret}`);
  }
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
