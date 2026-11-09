# toSub2 外部调用 API 文档

本文档面向通过外部服务调用 toSub2 控制台接口的场景，主要覆盖批量添加账号流程。

Base URL：`http://127.0.0.1:4399`（可用 `--host`、`--port` 或环境变量修改）

## 鉴权模型

除 `/api/bootstrap`、`/api/login`、`/api/logout` 外，所有 `/api/*` 接口都要求：

- 设置了 `CONSOLE_PASSWORD` 时：携带登录返回的 `tosub2_session` Cookie。
- 携带 `x-console-token: <token>` 请求头。

`token` 为服务进程内的全局令牌，服务重启后会变化。设置了控制台密码时，Cookie 会话有效期为 12 小时。

错误响应统一为：

```json
{ "error": "错误信息" }
```

响应头包含 `content-type: application/json; charset=utf-8` 和 `cache-control: no-store`。服务未开启 CORS，只适合服务端到服务端调用。

---

## 1. GET /api/bootstrap

获取控制台鉴权状态和全局 token。

### 成功 200

未设置密码，或 Cookie 会话有效：

```json
{
  "authRequired": true,
  "authenticated": true,
  "token": "全局 console token",
  "features": {
    "retry": true,
    "regenerate": true,
    "bulkActions": true,
    "smsProviders": [],
    "sub2apiUpload": true,
    "sub2apiMonitor": true,
    "totpSetup": true,
    "passwordAdd": true,
    "forceRelogin": true
  }
}
```

设置了密码但未登录：

```json
{
  "authRequired": true,
  "authenticated": false
}
```

### 失败

该接口本身不鉴权，通常只有服务端内部异常：

- `500`：`{"error":"Internal server error"}` 或具体异常信息。

---

## 2. POST /api/login

使用控制台密码换取 token 和会话 Cookie。

### 请求

```http
POST /api/login
content-type: application/json

{ "password": "控制台密码" }
```

未设置 `CONSOLE_PASSWORD` 时，请求体可为空，直接返回 token。

### 成功 200

```json
{
  "token": "全局 console token",
  "features": { "...": "同 bootstrap" }
}
```

同时返回：

```http
Set-Cookie: tosub2_session=<session>; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200
```

设置了 `CONSOLE_PASSWORD` 时，后续请求需要同时带 Cookie 和 `x-console-token`。

### 失败

| 状态码 | 场景 | 响应 |
|---|---|---|
| 400 | 请求体不是合法 JSON | `{"error":"Invalid JSON body"}` |
| 401 | 密码为空或错误 | `{"error":"控制台密码错误"}` |
| 413 | 请求体超过 1,000,000 字符 | `{"error":"Request body is too large"}` |
| 500 | 内部异常 | `{"error":"..."}` |

---

## 3. POST /api/logout

注销当前 Cookie 会话。不需要 `x-console-token`。

### 成功 200

```json
{ "ok": true }
```

同时清除 `tosub2_session` Cookie。

### 失败

| 状态码 | 场景 | 响应 |
|---|---|---|
| 401 | 设置了密码且当前会话无效 | `{"error":"请先登录控制台"}` |

---

## 4. POST /api/jobs/batch

批量添加账号，同时会更新已存在的同邮箱任务。

### 请求头

```http
content-type: application/json
cookie: tosub2_session=...
x-console-token: <token>
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
| 400 | 请求体不是合法 JSON | `{"error":"Invalid JSON body"}` |
| 413 | 请求体超过 1,000,000 字符 | `{"error":"Request body is too large"}` |
| 401 | 设置了密码但 Cookie 会话无效 | `{"error":"请先登录控制台"}` |
| 403 | token 缺失或错误 | `{"error":"Invalid console token"}` |
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

## 完整调用示例

### 已设置 CONSOLE_PASSWORD

```bash
TOKEN=$(curl -c cookie.txt -s http://127.0.0.1:4399/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"控制台密码"}' | jq -r .token)

curl -b cookie.txt -s -D - http://127.0.0.1:4399/api/jobs/batch \
  -H 'content-type: application/json' \
  -H "x-console-token: $TOKEN" \
  -d '{"text":"a@example.com----密码\nb@example.com","registerOnly":false}'
```

### 未设置 CONSOLE_PASSWORD

```bash
TOKEN=$(curl -s http://127.0.0.1:4399/api/bootstrap | jq -r .token)

curl -s -D - http://127.0.0.1:4399/api/jobs/batch \
  -H 'content-type: application/json' \
  -H "x-console-token: $TOKEN" \
  -d '{"text":"a@example.com----密码\nb@example.com"}'
```
