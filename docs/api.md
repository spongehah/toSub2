# toSub2 批量提交账号 API

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

## 完整调用示例

```bash
API_KEY=$(jq -r .apiKey tmp/chatgpt-onboarding-console/console-api-key.json)

curl -s -D - http://127.0.0.1:4399/api/jobs/batch \
  -H 'content-type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d '{"text":"a@example.com----密码\nb@example.com","registerOnly":false}'
```
