# toSub2 账号 API

Base URL：`http://127.0.0.1:4399`（可用 `--host`、`--port` 或环境变量修改）

## 访问密钥

服务启动时会自动生成随机访问密钥并持久化：

```text
tmp/chatgpt-onboarding-console/console-api-key.json
```

默认输出目录可通过 `ONBOARDING_OUTPUT_ROOT` 修改。文件权限为 `0600`，服务重启后会继续使用同一个密钥；删除该文件后重启服务会重新生成新密钥。

调用接口时在请求头中携带：

```http
x-api-key: <访问密钥>
```

也支持 `Authorization: Bearer <访问密钥>`。访问密钥等同于管理员权限，请妥善保管。

---

## POST /api/jobs/batch

批量添加账号，同时会更新已存在的同邮箱任务。

### 请求头

```http
content-type: application/json
x-api-key: <访问密钥>
```

### 请求体

```json
{
  "text": "a@example.com----密码----JBSWY3DPEHPK3PXP\nb@example.com",
  "registerOnly": false,
  "proxyUrl": ""
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 每行一个账号，最多 500 行；重复邮箱按最后一次出现处理 |
| `registerOnly` | boolean | 否 | `true` 时只登记账号，不立即登录；默认 `false` |
| `proxyUrl` | string | 否 | 账号代理；支持 `http`、`https`、`socks5`、`socks5h`。留空时使用服务端已配置的账号代理，服务端也没配置则无代理 |

### text 行格式

默认智能解析，推荐统一使用 `----` 分隔：

```text
email@example.com
email@example.com----密码
email@example.com----密码----2FA密钥
email@example.com----密码----2FA密钥----接码API
email@example.com----接码API
```

也支持 Tab、`|`、`::`、`;;`、逗号、两个以上空格等分隔符，但字段有歧义时会拒绝该行，建议外部服务固定使用 `----`。

当服务端邮件请求模式配置为 POST 时，非纯邮箱行按 POST 接码格式解析：

```text
email@example.com----编码后的请求体
email@example.com----密码----编码后的请求体
email@example.com----密码----2FA密钥----编码后的请求体
```

请求体不能超过 64 KB。

### 成功 201

即使全部是更新已有任务，也返回 `201`。

```json
{
  "jobs": [
    {
      "id": "任务 ID",
      "email": "a@example.com",
      "status": "queued",
      "prompt": "排队中，前方还有 0 条任务",
      "createdAt": "2026-11-09T08:00:00.000Z",
      "updatedAt": "2026-11-09T08:00:00.000Z",
      "lastOperationAt": "2026-11-09T08:00:00.000Z",
      "lastOperationType": "initial_authorization",
      "completedAt": null,
      "lastError": null,
      "canDownload": false,
      "loginMode": "password",
      "hasTotpKey": true,
      "autoEmailOtp": false,
      "securityCheckRequired": false,
      "canRetry": false,
      "canResume": false,
      "canRegenerate": false,
      "canForceRelogin": false,
      "canSetupTotp": false,
      "canAddPassword": true,
      "proxyConfigured": true,
      "autoRepairEligible": false,
      "autoRepairEligibilityReason": "上次授权不是全自动完成",
      "autoRepairBlocked": false,
      "attempt": 1,
      "queuePosition": 1
    }
  ],
  "created": 1,
  "updated": 1
}
```

- `created`：新创建的任务数。
- `updated`：已存在并更新凭据的任务数。
- `jobs` 按去重后的输入行顺序返回。

注意：当前实现中，`proxyUrl` 会同时写入本批所有已存在任务的代理；如果请求未传代理且服务端未配置代理，会清空这些已有任务的代理。

### 失败

| 状态码 | 场景 | 响应 |
|---|---|---|
| 401 | 访问密钥缺失或错误 | `{"error":"访问密钥无效"}` |
| 400 | 请求体不是合法 JSON | `{"error":"Invalid JSON body"}` |
| 413 | 请求体超过 1,000,000 字符 | `{"error":"Request body is too large"}` |
| 400 | text 为空 | `{"error":"请至少输入一行账号信息"}` |
| 400 | 超过 500 行 | `{"error":"一次最多添加 500 条任务"}` |
| 400 | POST 接码模式未配置统一 URL | `{"error":"POST 邮件接码模式需要先在控制台配置统一请求 URL"}` |
| 400 | POST 接码行字段不足 | `{"error":"第 N 行格式错误，POST 邮件接码请使用 邮箱----编码请求体"}` |
| 400 | 行内没有唯一邮箱 | `{"error":"第 N 行必须包含一个独立邮箱"}` |
| 400 | POST 接码行缺少请求体 | `{"error":"第 N 行缺少 POST 请求体"}` |
| 400 | 无法区分密码和请求体 | `{"error":"第 N 行无法区分密码和 POST 请求体，请将编码请求体放在最后"}` |
| 400 | 请求体超过 64 KB | `{"error":"第 N 行 POST 请求体不能超过 64 KB"}` |
| 400 | 2FA 密钥格式错误 | `{"error":"第 N 行2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7"}` |
| 400 | 存在无法识别的连续短横线 | `{"error":"第 N 行存在 X 个连续短横线，无法确定是分隔符还是字段内容，请改用 \| 或 Tab 分隔"}` |
| 400 | 无法识别邮箱和账号字段 | `{"error":"第 N 行无法识别出独立邮箱和账号字段"}` |
| 400 | 多种分隔方式均可解析 | `{"error":"第 N 行存在多种可能的字段分隔方式，请改用 ---- 明确分隔"}` |
| 400 | 分隔符混用 | `{"error":"第 N 行似乎混用了多种分隔符，密码中又识别到 URL 或 2FA 密钥，请统一改用 ---- 分隔"}` |
| 400 | 行内识别到多个完整邮箱 | `{"error":"第 N 行中识别到多个完整邮箱，无法确定哪个是账号"}` |
| 400 | 逗号/分号可能属于 URL | `{"error":"第 N 行中的 URL 可能包含逗号或分号，请改用 ---- 分隔字段"}` |
| 400 | 代理协议或格式错误 | `{"error":"账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址"}` |
| 400 | 代理协议不支持 | `{"error":"账号代理只支持 http、https、socks5 和 socks5h 协议"}` |
| 500 | 文件、凭据存储等内部异常 | `{"error":"..."}` |

---

## POST /api/sub2api/relogin

完整重新登录指定邮箱，授权完成后更新一个 Sub2API 账号。接口复用现有外部访问密钥；控制台账号行中的“重新登录并更新 Sub2API”调用同一接口。

### 请求体

```json
{
  "email": "user@example.com",
  "sub2apiAccountId": 123
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `email` | string | 是 | 去除首尾空格并统一小写，定位本地最新的同邮箱任务；账号必须已在 toSub2 中登记 |
| `sub2apiAccountId` | number | 否 | 正安全整数，不接受数字字符串；传入时直接绑定该远端账号，不再发查询请求 |

必须先在 toSub2 保存 Sub2API 后端地址和管理员 API Key，但不必开启全局巡检。该操作跳过刷新令牌，不要求远端账号异常，也不受全局巡检号池、时间窗口和冷却限制。

未传远端 ID 时，只调用一次服务端筛选查询，不遍历账号列表：

```http
GET /api/v1/admin/accounts?search=<email>&platform=openai&type=oauth&page=1&page_size=1&sort_by=created_at&sort_order=desc
```

`search` 的匹配语义是“账号名称包含邮箱”，不是精确查询 `credentials.email`。匹配多个账号时，取创建时间倒序的第一条；未找到本地或远端账号时，不启动登录。一次操作只更新绑定的远端 ID，不更新同邮箱的其他记录。

### 接受任务 202

```json
{
  "accountExists": true,
  "started": true,
  "email": "user@example.com",
  "jobId": "本地任务 ID",
  "status": "queued",
  "prompt": "排队中，前方还有 0 条任务",
  "queuePosition": 1,
  "requiresInput": false,
  "inputType": null,
  "attempt": 2,
  "manualInputAutoRetryCount": 0,
  "operation": {
    "id": "本轮操作 ID",
    "sub2apiAccountId": 123,
    "phase": "authorizing",
    "error": null,
    "startedAt": "2026-11-23T08:00:00.000Z",
    "completedAt": null,
    "updateStatus": "pending"
  }
}
```

`started=true` 只表示任务已接受并入队，不能据此判定登录或远端更新成功；应轮询下方状态接口。排队后可能很快启动，返回的 `status` 以实际快照为准。

授权成功后调用 Sub2API 的 `apply-oauth-credentials`，提交新凭据，并局部更新 `extra.codex_fingerprint_mode` 为全局巡检配置中的值，保留其他自定义 `extra`。随后显式清除错误并恢复调度，全部成功后才标记操作完成。Sub2API 会校验 OAuth 身份，错误的远端 ID 不会被当作新账号创建。

授权成功而更新失败时，`status` 可以为 `completed`，但 `operation.phase` 为 `failed`、`operation.updateStatus` 为 `failed`。启用全局巡检后，现有待重传机制会使用相同目标和回写方式重传，不重复登录；未启用巡检时，不新增后台重传定时器。

### 业务失败

业务错误响应包含 `started:false`、`code`、`error` 以及能够确定的账号／任务快照；未通过鉴权时沿用现有鉴权错误响应。

| 状态码 | code | 场景 |
|---|---|---|
| 400 | `INVALID_EMAIL` | 邮箱缺失或格式错误 |
| 400 | `INVALID_SUB2API_ACCOUNT_ID` | 远端 ID 不是正安全整数 |
| 400 | `INVALID_REQUEST` | 请求体无效 |
| 404 | `ACCOUNT_NOT_FOUND` | 本地没有该邮箱账号，`accountExists=false` |
| 404 | `SUB2API_ACCOUNT_NOT_FOUND` | 邮箱筛选未找到远端账号 |
| 409 | `ACCOUNT_BUSY` | 同邮箱已在排队、登录、等待输入或远端回写；返回当前状态，不重复启动 |
| 409 | `SUB2API_NOT_CONFIGURED` | 尚未保存可用的 Sub2API 后端配置 |
| 409 | `SERVICE_SHUTTING_DOWN` | 服务正在关闭 |
| 502 | `SUB2API_REQUEST_FAILED` | 远端查询失败 |
| 504 | `SUB2API_REQUEST_TIMEOUT` | 远端查询超时 |
| 500 | `RELOGIN_START_FAILED` | 启动任务时发生内部错误 |

---

## GET /api/sub2api/relogin/status?email=...

按邮箱查询当前本地登录状态及最近一次单账号更新操作，鉴权与启动接口相同：

```http
GET /api/sub2api/relogin/status?email=user%40example.com
x-api-key: <访问密钥>
```

成功返回 `200`，字段与启动成功的快照相同，但不包含 `started`。没有执行过单账号更新的账号也可查询当前登录状态，此时 `operation=null`。本地账号不存在返回 `404`、`code=ACCOUNT_NOT_FOUND` 和 `accountExists=false`；邮箱无效返回 `400`、`code=INVALID_EMAIL`。

| 字段 | 说明 |
|---|---|
| `status`、`prompt` | 原生任务状态与当前步骤提示 |
| `queuePosition` | 排队位置，非排队时为 0 |
| `requiresInput`、`inputType` | 是否正在等待人工输入，以及具体输入类型；自动收码运行中不视为需要人工输入 |
| `attempt`、`manualInputAutoRetryCount` | 授权尝试次数、本轮因人工输入触发的自动重试次数 |
| `operation.id`、`operation.sub2apiAccountId` | 最近一轮单账号操作标识及绑定的远端账号 |
| `operation.phase` | `authorizing`、`updating`、`completed`、`failed`、`canceled` |
| `operation.updateStatus` | `not_started`、`pending`、`updating`、`succeeded`、`failed`，独立于本地登录状态 |
| `operation.error`、`operation.startedAt`、`operation.completedAt` | 本轮错误与开始／结束时间 |

原生状态包括 `registered`（已登记）、`queued`（排队）、`starting`／`working`（登录中）、`password`／`email_otp`／`mfa_otp`／`phone`／`phone_otp`（对应输入阶段）、`finalizing`（生成文件）、`completed`、`failed`、`canceled`、`reauth_required`、`resume_available` 等。查询也可反映账号当前正在进行的独立 2FA、添加密码或令牌刷新流程，保留其原生状态。

所有完整登录入口在首次确认需要人工输入时，会立即自动重新登录一次。自动填密码、TOTP、邮箱或短信收码仍在运行时不会触发重试；重试后仍需输入时，可在控制台现有输入框完成操作，沿用 `INPUT_WAIT_TIMEOUT_MS`，默认等待三分钟，超时取消并释放并发。独立设置 2FA、添加密码流程不套用这次自动重登规则。

状态查询只返回必要的任务和操作信息，不返回密码、授权令牌、邮件 API 地址或 TOTP 密钥。操作元数据会持久化，服务重启后不会继续显示无法恢复的虚假进行中状态。

### 调用与轮询示例

```bash
curl -s -X POST http://127.0.0.1:4399/api/sub2api/relogin \
  -H 'content-type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d '{"email":"user@example.com","sub2apiAccountId":123}'

curl -s -G http://127.0.0.1:4399/api/sub2api/relogin/status \
  -H "x-api-key: $API_KEY" \
  --data-urlencode 'email=user@example.com'
```

以 `operation.phase=completed` 且 `operation.updateStatus=succeeded` 判定整轮操作成功；`status=completed` 本身只表示本地授权完成。

---

## 完整调用示例

```bash
API_KEY=$(jq -r .apiKey tmp/chatgpt-onboarding-console/console-api-key.json)

curl -s -D - http://127.0.0.1:4399/api/jobs/batch \
  -H 'content-type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d '{"text":"a@example.com----密码\nb@example.com","registerOnly":false}'
```
