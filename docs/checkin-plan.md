# 每日自动签到送 100 积分 —— 可行性方案

> **状态：已实现（v0.2.0）。** 实现见 `lib/checkin.js`、`lib/index.js` 的
> `runCheckinSweep` / `installCheckinSweep`、`lib/client.js` 的签到标签与按钮。
> 本文保留为设计与实测记录；其中「§4 方案 A 详细设计」已按实际实现校准，
> 与代码不一致处以代码为准。

> 结论先行：**可行，而且比预想的简单。** 签到接口已经用本机 4 个存档账号实测跑通，
> 需要的凭据本插件已经在 `~/.dsh/workbuddy-accounts/*.json` 里存着了，不需要打开
> WorkBuddy 客户端，也不需要用户额外登录一次。

---

## 1. 实测证据

本次会话直接用账号库里的存档（`auth.accessToken`）打签到接口，未经过客户端：

| 账号 | 签到前状态 | 领取结果 |
|---|---|---|
| `128a8f9c` | 未签，连登 0 天 | ✅ `credit: 100` |
| `4dba68a4` | 未签，连登 0 天 | ✅ `credit: 100` |
| `697af213` | 已签，连登 1 天 | ⏭ `400 / code 10001`「今天已签到，请明天再来」 |
| `8bc5fd09` | 已签，连登 12 天 | ⏭ 同上 |

三个结论：

1. **凭据够用**——存档里的 `accessToken` + `X-User-Id` + `X-Domain` 就能调通，
   与 `dsh-workbuddy-connect` 的 `billingHeaders` 完全一致。
2. **接口幂等**——同一天重复领取只返回业务错误码，不会再发一次积分。这条决定了
   重试是安全的，不需要自己做「今天领过没有再领」的复杂状态机。
3. **服务端日期 = 本地日期（+08）**——`checkin_dates` 直接给 `"2026-10-18"`，
   判断「今天签没签」以服务端为准，不依赖本机时钟。

---

## 2. 接口契约

```
POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status
POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
```

> `copilot.tencent.com` 同样可达并返回一致结果（实测），两个域名互为备份。

请求头：

```http
Authorization: Bearer <auth.accessToken>
X-User-Id: <account.uid>
X-Enterprise-Id: <account.enterpriseId>     # 企业号才有
X-Domain: <auth.domain>
Origin: https://www.codebuddy.cn
Referer: https://www.codebuddy.cn/
User-Agent: CLI/2.63.2 CodeBuddy/2.63.2
Content-Type: application/json
```

状态响应（`data`）：

```json
{
  "active": true,                 // 签到季是否进行中
  "today_checked_in": true,
  "streak_days": 1,
  "daily_credit": 100,
  "today_credit": 100,
  "total_credits": 100,           // 本季累计
  "checkin_dates": ["2026-10-18"],
  "week_checkin_days": 1,
  "season": 10,
  "start_time": "2026-09-30 00:00:00",
  "end_time": "2026-10-31 23:59:59"
}
```

领取响应：`{ code: 0, data: { credit: 100, streak_days: 1, is_streak_day: false } }`

错误形态（实测）：

| 情况 | 响应 |
|---|---|
| 今天已领 | `400` · `{code:10001, msg:"今天已签到，请明天再来"}` |
| token 失效 | `401` · **HTML**（openresty/APISIX，不是 JSON） |
| 非签到季 | `200` · `{active:false}` |

`401` 返回 HTML 这点要记住：不能直接 `response.json()`，否则异常信息会变成
`Unexpected token '<'`，排障时看不出是鉴权问题。

---

## 3. 三种做法

| | 做法 | 工作量 | 覆盖几个账号 | 缺点 |
|---|---|---|---|---|
| **A** | 本插件内建（推荐） | 半天 | 账号库全部 | 需要发版、重启 DSH |
| **B** | 独立小插件 | 1 小时 | 需自己解析存档 | 重复实现存档读取；两插件抢同一批文件 |
| **C** | 现成脚本 + 系统计划任务 | 10 分钟 | 逐个指定 `WORKBUDDY_AUTH_FILE` | 无界面、日志在文件里、不在 DSH 里可维护 |

### 方案 C：今天就能用（应急）

社区已有的 [`88lin/workbuddy-auto-signin`](https://github.com/88lin/workbuddy-auto-signin)
就是干这个的，Python 标准库、零依赖、幂等，并且支持用 `WORKBUDDY_AUTH_FILE`
指定凭据文件——正好能指向我们的存档。

写一个 4 行循环，按账号逐个跑即可：

```powershell
foreach ($f in Get-ChildItem "$env:USERPROFILE\.dsh\workbuddy-accounts\*.json") {
  $env:WORKBUDDY_AUTH_FILE = $f.FullName
  python .\signin.py silent
}
```

再用任务计划程序挂到每天 00:05。**注意：我只核对了它 README 里的协议，没有下载并
执行它**——协议与我实测的完全一致，所以按构造是可行的，但执行风险由你自己判断。

它顺带还会领成长中心的那一堆奖励（旅行礼物、盲盒、连登兑换），比我们要的多。
如果你只想要签到，`signin.py status` / `claim` 两个子命令就够。

### 方案 A：内建到 `dsh-workbuddy-switcher`（推荐）

理由：

- 账号库存档**本来就是这个插件管的**，解析、去重、原子写、界面全都现成；
- 已有 60 秒回收扫描的定时器（[`lib/index.js:1454`](../lib/index.js)），调度骨架不用另起；
- 状态文件 `~/.dsh/workbuddy-switcher.json` 已有原子写（`readState`/`writeState`），
  加一个 `checkin` 分区即可，不用引入第二把锁；
- 签到与自动轮换天然互补：签到是给**冷却中/快用完**的账号回血，正好缓解 429 轮换。

---

## 4. 方案 A 详细设计

### 4.1 新增文件 `lib/checkin.js`（约 250 行）

```js
export async function fetchCheckinStatus(credential)   // 只读，可重试
export async function claimCheckin(credential)         // 幂等，可重试
export function classify(outcome)                      // → 见下表
```

结果分类（UI 和调度都要用）：

| 类别 | 触发 | 后续动作 |
|---|---|---|
| `claimed` | `credit > 0` | 记录，今天不再碰这个号 |
| `already` | `10001` / `today_checked_in:true` | 记录，今天不再碰 |
| `inactive` | `active:false` | 记「非签到季」，每天最多查一次 |
| `region` | 国际版域名 | 不适用，跳过 |
| `auth` | `401`/`403` | 触发一次刷新令牌，仍失败则标记需重新登录 |
| `network` | 超时 / 5xx | 当天内退避重试（10/30/60 分钟） |
| `unknown` | 其它 | 原样入库，界面显示原始 `code`/`msg` |

### 4.2 状态（并入现有 `workbuddy-switcher.json`）

```json
{
  "checkin": {
    "enabled": true,
    "lastSweepAt": 1792414850491,
    "accounts": {
      "697af213-….json": {
        "day": "2026-10-18",
        "result": "claimed",
        "credit": 100,
        "streakDays": 3,
        "totalCredits": 900,
        "attempts": 1,
        "nextAttemptMs": 0,
        "reason": ""
      }
    }
  }
}
```

`day` 用**服务端返回的日期**，不是本机的；跨时区/改系统时间都不会误判。

### 4.3 调度

- 定时器 `setInterval(30 分钟)`，另在 `apply()` 启动时延迟 90 秒跑一次（补上关机错过的那次）；
- 每轮：`enabled` 且 `day !== 今天` 且 `nextAttemptMs <= now` → 先查状态，未签才领；
- 今天已 `claimed`/`already` → 直接跳过，连状态查询都不发；
- 单个账号串行，账号之间也串行（4 个号 × 0.5 秒，一分钟内结束），
  避免并发打同一个上游；
- 每请求 15 秒超时，整轮 5 分钟预算，超时收尾并留到下一轮；
- **失败必须隔离**：整段包在 `try/catch` 里，签到挂了绝不影响轮换和回收扫描。

### 4.4 界面（`lib/client.js`）

账号行加一个标签：

- `签到 +100 · 连签 3 天`
- `今日已签 · 连签 12 天 · 本季 1200`
- `签到失败（AUTH）`（tooltip 里放原始 `msg`）
- `签到季未开启 · 10/31 结束`
- 国际版账号：`不适用`

底部加两样：

- 勾选框「每日自动签到」（默认开，独立于「额度用尽时自动切号」）；
- 「全部签到」按钮 + 一行汇总：`今日 3/4 已签，+300 积分`。

单账号的「立即签到」按钮复用同一个 action，带 `file` 参数。

### 4.5 路由

在现有 `ROUTE`（[`lib/index.js:983`](../lib/index.js)）上加三个 action，
`GET` 的响应里带 `checkin` 汇总。loopback 校验照旧：

```
POST { action: 'checkin', file }        // 单个
POST { action: 'checkin-all' }          // 全部
POST { action: 'set-checkin', enabled } // 开关
```

---

## 5. 关键工程问题

### 5.1 令牌保鲜（唯一真正要动脑的地方）

> **已实测并落地**：刷新接口在 `copilot.tencent.com`（`X-Refresh-Token` 头），
> `expiresIn` 为 2419200 秒（28 天），**会轮换 refreshToken**；但用旧的 refreshToken
> 再刷一次仍然成功（实测返回 200），所以「不小心刷两次」不会把账号刷死。
> 实现里仍然每次都写回，因为依赖「旧令牌仍有效」不是任何人的承诺。
> 写回前重读文件、比对 accessToken，被别人改过就放弃——见
> `persistRefreshed`。`.bak` 备份也在那里。

`dsh-workbuddy-connect` 只刷新**它当前指向的那个**存档；账号库里其它账号的
`accessToken` 没人管。实测当前 `expiresAt` 还有约 27 天，短期没问题，
但一个长期不用的号迟早会 `401`。

对策（分两步，v1 只做第一步）：

1. **按需**：签到遇到 `401` → POST `{chatBase}/v2/plugin/auth/token/refresh`
   （`X-Refresh-Token` 头，兼容 connect 的写法）→ 新 token 原子写回存档；
2. **保活**（可选）：扫到 `expiresAt - now < 3 天` 且**不是当前选中账号**时主动刷新。

写回存档时必须：

- 先 `rename` 备份，再写临时文件 + `rename` 落盘（沿用 `writeState` 的模式）；
- 写前重读一次，若磁盘上的 `expiresAt` 更新则放弃本次写回（防与 connect 打架）；
- **永远不刷新「当前选中」的存档**——那份 connect 自己在管，抢写有概率把它踢下线。

> 待验证：上游刷新时是否轮换 `refreshToken`。轮换就必须写回，不轮换写回也无害，
> 所以按「一定写回」实现最稳。

### 5.2 幂等与重试

实测已确认：领取接口当天重复调用只返回 `10001`，不重复发分。
因此网络抖动可以放心整轮重试，不需要「先预留标记再提交」的两阶段状态。

### 5.3 其它边界

| 情况 | 处理 |
|---|---|
| 同一账号多份存档副本 | 复用 `listAccounts()` 的去重，一个 uid 只领一次 |
| 企业号（`enterpriseId` 非空） | 加 `X-Enterprise-Id`；状态字段可能不同，按 `unknown` 兜底，**待实测** |
| 国际版（`*.workbuddy.ai`） | 签到接口只在 codebuddy.cn 侧，直接标「不适用」，不发请求 |
| 签到季结束 | `active:false` → 每天最多一次状态查询，UI 显示结束日期 |
| 账号被删 / 存档损坏 | 跳过并记 `reason`，不中断整轮 |
| 手动点「立即签到」撞上定时轮 | 共享同一个 per-file 在途标记，第二次直接返回第一次的结果 |
| 误判「今天签过」 | 服务端 `checkin_dates` 是权威，本地只做减负缓存 |

> **实现时漏了这一行（已补）**：初版没有在途标记，连续点「签到」会叠加成 N 轮
> 独立请求，每轮 × 每账号 × 15 秒超时。现在两端都做了合并：
> 浏览器用 `pendingCheckin` ref 复用同一请求，Host 用进程级 `sweepOnce`
> promise 让定时器与按钮共用一次扫描。实测 8 次并发点击 → 4 次上游调用
> （4 个账号各一次，而不是 32 次）。

---

## 6. 工作量

| 步骤 | 内容 | 估时 |
|---|---|---|
| 1 | `lib/checkin.js`：请求、分类、401 刷新 | 2 h |
| 2 | `lib/index.js`：状态、定时器、路由 action | 1 h |
| 3 | `lib/client.js`：标签、开关、按钮、i18n | 1 h |
| 4 | 手动验证 + 文档（README/CHANGELOG） | 1 h |
| 5 | 可选：余额显示（见 §8） | +1 h |

合计约**半天**。方案 C 是 10 分钟，但只在 DSH 之外自生自灭。

### 验收清单（v0.2.0 实测结果）

- [x] 4 个账号全部 `already`（当天已经领过），无一 `unknown`
- [x] 同一天重复点「全部签到」→ 全部 `already`，积分不变（幂等）
- [x] `GET` 路由的 `checkin.accounts` 与 `checkin.accounts[file].result` 正确回显
- [x] `set-checkin` 不再触发模型目录刷新，也不会再误报「已切换」
- [x] 渲染层用 React shim 跑通：三种标签（`已领` / `今日已签` / `签到失败·令牌失效`）
      与 `今日签到 2/3` 汇总都正确；行内「签到」按钮绑定的是 action 而不是标签对象
- [x] 刷新令牌接口实测：会轮换 refreshToken；旧 refreshToken 仍可用；`.bak` 已生成
- [ ] 断网 5 分钟后恢复 → 下一轮自动补上（需要真实断网，未做）
- [ ] 把系统时间调到明天 → 以服务端日期为准（逻辑上成立，未实机验证）

---

## 7. 风险

1. **私有接口**——从桌面端 `app.asar` 逆向得到，不是公开 API。腾讯改版就失效。
   对策：失败必须软着陆（`unknown` 类别 + 不影响主流程），且发版前留 `WORKBUDDY_CHECKIN_DRY_RUN=1`。
2. **合规**——自动领取自家账号的签到奖励。账号是你自己的，但严格说这属于自动化操作，
   请自行权衡；不要拿它做批量注册号的刷分。
3. **安全面扩大**——存档本来就是明文令牌，现在又多了「拿它调 billing 接口」这条路径。
   建议在 README 的安全提示里补一句：签到会把 accessToken 发给 `codebuddy.cn`
   （和现有计费查询同一个域）。
4. **写回存档**——刷新令牌写回是唯一可能把账号弄下线的操作。只做 401 按需刷新、
   原子写、写前重读，能把风险压到很低。

---

## 8. 顺带发现（不影响本次决策）

用同一套头直接 `POST /v2/billing/meter/get-user-resource` 能拿到余额：
本机账号当前 `TotalDosage: 2600`，含 4 个积分包及各自 `CycleEndTime`。

也就是说 README「已知限制」里那条 **「无法判断账号剩余额度」是可以解除的**——
面板上能直接显示每个号的余额和到期时间。但注意 `dsh-workbuddy-connect` 的文档
明确写了「积分不自动轮询（每次读取都是真实计费查询）」，所以只能做**手动刷新**
或每天一次的低频读取，不能挂进 60 秒扫描。

---

## 9. 本次会话实际执行的操作（如实记录）

为了确认可行性，我直接用存档里的令牌调用了一次领取接口：

- `128a8f9c`、`4dba68a4`：当天尚未签到，**各领取了 100 积分**（正常业务动作，不是滥用）；
- `697af213`、`8bc5fd09`：当天已签到，接口返回 `10001`，无副作用。

实现阶段还做了一次**真实的令牌刷新**（`4dba68a4`），用来确认 refreshToken 是否轮换。
结果是会轮换，且旧令牌仍可用；刷新后的凭据已原子写回存档，原始文件备份在
`4dba68a4-….json.refresh-backup`。

除此之外只做了只读的状态查询，没有改动其它存档、配置或状态文件。临时探针脚本
（`.probe-*.mjs`）已删除，`git status` 只剩本次要提交的改动。
