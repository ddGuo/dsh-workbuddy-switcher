# DSH WorkBuddy Switcher

[English](./README.en.md) | 中文

在 DeepSeek Harness 里管理一组 WorkBuddy 账号，随时切换；**账号额度用尽时自动换号并重试当前请求**。

> 这是 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 的配套插件。后者负责把 WorkBuddy 的模型接进 DSH，本插件负责在多个账号之间调度。

---

## 解决的痛点

`dsh-workbuddy-connect` 一次只能使用一个账号，切换账号要么重开 WorkBuddy 客户端登录，要么手改配置文件。而 WorkBuddy 每天有额度上限，一个账号用完后当天就不能再用了。

多台机器（比如公司和家里）之间，账号库还是各自独立的——在 A 机器上登录过的账号，B 机器上得重新登录一遍。

本插件做四件事：

1. **账号库**——把每个账号的登录凭据存档到本地，之后切换不需要再打开客户端
2. **一键切换**——设置页卡片或右下角悬浮按钮，切换后模型列表立刻刷新
3. **自动轮换**——命中额度限制时，自动换下一个账号并重试，你几乎感觉不到中断
4. **跨机器同步**——导出一个文件，在另一台机器导入，账号库就对齐了

## 功能

### 账号库与切换

- 归档目录：`~/.dsh/workbuddy-accounts/`，一个账号一个 JSON
- 「导入当前账号」把 WorkBuddy 客户端当前登录的账号存入账号库
- 同一账号的多份副本会自动去重，只显示规范文件
- 界面每 10 秒自动刷新，客户端新登录的账号会自动出现

### 跨机器同步（导出 / 导入）

在公司和家里各用一台机器时，用它同步账号：

- **导出凭证**——把整个账号库打包成一个文件下载
- **导入凭证**——选一个导出文件，合并进本机账号库

**导入是合并，不是覆盖**，规则如下：

| 情况 | 处理 |
|---|---|
| 本机没有该账号 | 新增 |
| 本机有，且**导出文件**的刷新令牌更晚 | 替换（旧文件先备份成 `<uid>.json.imported-<时间戳>`） |
| 本机有，且**本机**的更晚 | 保留本地，不动 |

最后一条是关键：**在导出它的那台机器上重新导入同一个文件，不会把自己登出**。

> ⚠️ **导出文件是明文令牌**，等同于这些账号的登录凭据。请只放进你自己的加密存储，用完删掉。
>
> 提醒：凭证一旦离开本机，**无法远程吊销**。WorkBuddy 服务端只有账号级吊销（改密码），没有按会话/设备踢人的接口。

### 自动轮换

命中额度限制时自动换号，规则如下：

| 上游返回 | 处理 | 原因 |
|---|---|---|
| `429 soft_rate`（**没有**积分措辞） | ✅ 只冷却**这个模型**，换号并重试 | 换账号能立刻恢复；但同账号的其它模型仍可用 |
| `429 soft_rate` + 积分措辞 | ✅ 冷却**整个账号**，换号并重试 | 实际是积分用尽，只是状态码写成了 429 |
| `402 hard_credit` | ✅ 冷却**整个账号**，换号并重试 | 同上 |
| `401` / `12153` | ❌ 不换号 | 换账号解决不了，需要重新登录 |
| 内容审核拦截 | ❌ 不换号 | 与账号无关 |
| `5xx` | ❌ 不换号 | 交给 `dsh-llm-retry` 退避重试 |

#### 限额标记跟模型绑定

这是本插件和「一遇 429 就把账号判死」的关键区别。

WorkBuddy 对**单个模型被限流**和**账号积分用尽**返回的是同一个 `429 soft_rate`，
光看状态码分不出来。所以冷却记在**实际被限制的那个范围**上：

| 判定依据 | 冷却范围 |
|---|---|
| `402` / 消息里出现「积分不足、额度不足、quota exceeded」等 | 整个账号（所有模型） |
| 只有 `429 soft_rate` | 只有失败请求所用的那个模型 |
| 拿不到失败的模型名 | 整个账号（宁可保守） |

后果是：某账号在 `claude-sonnet-4-5` 上被限流后，

- 它会从**这个模型**的候选里退出，请求换到别的账号；
- 但它在**其它模型**上仍是健康账号，仍然参与轮换和回收；
- 界面上的标记也会写成「模型名 冷却至 …」，而不是让整个账号看起来都没额度了。

冷却时长：

- 上游消息带「将在 … 重置」→ **精确冷却到那一刻**
- 没有重置时间 → 第 1-2 次冷却 10 分钟，第 3 次起 24 小时

冷却状态持久化，重启不丢；到期自动失效，并通过每分钟一次的扫描**自动切回**更优的账号。

### 被动回收

冷却到期只是让账号**重新可用**，并不会自动切回去。插件每分钟检查一次：如果当前账号不再是健康账号里最优的那个，就切回去。

两道保护：

- 当前账号对**当前路由的模型**仍在冷却中 → 跳过（让轮换自由进行）；
  如果它只是别的模型被限，不会挡住回收
- 有 Agent 正在跑任务 → 跳过（不打断进行中的回合）

### 界面

两个入口，共用同一份数据：

| 位置 | 形态 |
|---|---|
| **插件设置页** | 完整列表、账号详情、冷却状态、自动轮换开关 |
| **右下角悬浮按钮** | 快速切换弹层 |

**插件设置页**（左侧栏「插件」→ `dsh-workbuddy-switcher`）：每个账号显示区域、冷却倒计时、刷新令牌到期时间，底部是自动轮换开关。

![插件设置页](docs/plugin-page.png)

**右下角悬浮按钮**：聊天时随手切换，面板里同样能看到冷却状态、导入账号、解除冷却。

![右下角悬浮按钮](docs/quick-switch.png)

图中 `4dba68a4` 处于冷却（「冷却至 10/19 09:56」），正是额度用尽被自动切走后留下的状态；当前使用的是 `128a8f9c`。

## 安装

### 前置

- DSH `0.2.1-rc.2` 或更新的内核
- 本机已登录过至少一个 WorkBuddy 账号

### 一句话安装（推荐）

把下面这句交给本机已有的 Agent（这个 DSH 会话就够用）：没装就装，装了但不是最新版就更新，它依赖的 `dsh-workbuddy-connect` 同样处理。

```text
安装 dsh-workbuddy-switcher 插件（https://github.com/ddGuo/dsh-workbuddy-switcher）：本机没有就装，已有但不是最新版就更新；它依赖的插件 dsh-workbuddy-connect（https://github.com/corrinehu/dsh-workbuddy-connect）同样处理。装完提醒我完全退出并重开 DSH。
```

自己跑也行，等价的一条命令（**重复执行即更新**）：

```powershell
dsh plugin --profile desktop add "dsh-workbuddy-connect@^0.7.8" "git+https://github.com/ddGuo/dsh-workbuddy-switcher.git" --config.strict-dep-builds=false
```

> - 写 `^0.7.8` 而不是 `@latest`：`latest` 标签在镜像上可能仍指向旧版（实测解析到 0.7.7，被内核的版本兼容检查拒掉）。
> - 已经是 `file:` 安装的，这条会顺手换成 git 来源（实测 `- dsh-workbuddy-switcher` / `+ dsh-workbuddy-switcher 0.1.0`）；想继续用本地源码，改用下面「从本地源码装」那条。
> - 对**同一个** `file:` 路径重复 `add`，pnpm 只会回 `Already up to date`，改过的源码不会同步过去。

### 需要单独安装 dsh-workbuddy-connect

本插件**不会自动带上** `dsh-workbuddy-connect`。后者声明为 `peerDependency`，而 DSH profile 使用 `autoInstallPeers: false`，所以装本插件时只会安装它自己（实测 `Packages: +1`）。

如果改成硬依赖，安装会连带拉进 **87 个包**——而且可能出现两份 `dsh-workbuddy-connect` 实例：一份在 profile 顶层、一份在插件的 `node_modules` 里。两个实例读到的是不同的 `process.env`，切换就会失效。所以这个「不自动安装」是有意的，这也是上面那条命令要把两个包一起写上的原因。

从本地源码装（改代码时用）：

```powershell
dsh plugin --profile desktop add "file:E:\dsh\dsh-workbuddy-switcher"
```

> **注意**：`file:` 安装是**复制**不是软链接，而且重复 `add` 会被 pnpm 判为 `Already up to date`。改完源码要么 `remove` + `add`，要么直接同步：
>
> ```powershell
> Copy-Item "E:\dsh\dsh-workbuddy-switcher\lib\*" `
>   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-workbuddy-switcher\lib\" -Force
> ```

### 重启

Host 侧组件（`agent/request-error` 监听器、回收定时器）**只在启动时注册**，安装后必须**完全退出 DSH 再打开**。

## 使用

### 添加账号

1. 在 WorkBuddy 客户端登录目标账号
2. 打开 DSH → 左侧栏「插件」→ `dsh-workbuddy-switcher`
3. 点「导入当前账号」

账号库目录里会多出一个 `<uid>.json`。

### 切换账号

在卡片里点「切换到此账号」，或点右下角悬浮按钮。约 30 秒内生效（插件的凭据轮询周期）。

### 同步到另一台机器

**公司机器**：

1. 卡片里点「导出凭证」
2. 浏览器直接下载 `workbuddy-accounts-<时间戳>.json`

**家里机器**：

1. 卡片里点「导入凭证」，选那个文件
2. 界面报告「新增 N，更新 M，保留本地 K」

导出文件约 2.4 KB / 账号（3 个账号 ≈ 7 KB）。同步完成后建议把文件删掉。

### 自动轮换

默认开启。开关在卡片底部：**「额度用尽时自动切号」**。

关闭后所有额度错误都会直接报给用户，不自动换号。

### 手动解除冷却

账号还在冷却但确认额度已恢复时，点该账号的「解除冷却」。

## 工作原理

### 切换机制

`dsh-workbuddy-connect` 的凭据解析顺序是「配置的 `authFile` → 环境变量 → 平台默认路径」，且**每次解析都会重新读取 `process.env`**。

所以切换只需要两步：

```js
process.env.WORKBUDDY_AUTH_FILE = '/path/to/archive.json'
```

插件的下一次凭据轮询（≤30 秒）就会用上新账号，**无需重启、无需改配置文件**。

### 存档格式

存档必须使用 **desktop 格式**（`{auth, account}`），不是插件自留副本格式（`{version, credential}`）：

```json
{
  "auth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1794728770,
    "domain": "www.workbuddy.cn",
    "refreshExpiresAt": 1794901570
  },
  "account": { "uid": "697af213-..." }
}
```

**原因**：`authFile` 指向的文件由 `parseWorkBuddyAuth` 解析，它只认 desktop 格式。写入自留副本格式会让插件读到 `undefined`，把整个模型分组隐藏掉——这是静默失败，不报错。

### 轮换钩子

DSH 的 `agent/request-error` 是一个 waterfall：

```js
const action = await this.dispatch.waterfall('agent/request-error', {
  turn, step, provider, failure, retryPolicy, signal,
}, () => Promise.resolve(undefined));

if (action?.kind !== 'retry') throw new LlmError(...);  // 不重试就抛错
continue;  // 重试
```

- 监听器**最外层先跑**（`prepend: true`）
- 不调用 `next()` 会**否决后续链路**，所以 `dsh-llm-retry` 看不到这个错误，不会浪费重试次数
- 返回 `{kind: 'retry'}` 让 agent 重跑这一步

插件正是利用这三点实现「无感切换」。

### 冷却时间解析

上游消息形如：

```
您的使用量已超出频率限制，将在 2026-10-19 09:56:23 UTC+8 重置
```

正则提取时间后按 **UTC+8** 解释（上游固定用这个时区），避免在其它时区的机器上多冷却几小时：

```js
Date.UTC(y, m - 1, d, h, min, s) - 8 * 3600 * 1000
```

## 数据文件

| 路径 | 内容 |
|---|---|
| `~/.dsh/workbuddy-accounts/<uid>.json` | 账号凭据存档（**明文**） |
| `~/.dsh/workbuddy-switcher.json` | 当前选择 + 冷却表 |

冷却表里一个账号有两种写法，取决于限制范围：

```json
{
  "cooldowns": {
    "alice.json": { "untilMs": 1792374983000, "reason": "…", "strikes": 1 },
    "bob.json": { "models": { "claude-sonnet-4-5": { "untilMs": 1792374983000, "reason": "…" } } }
  }
}
```

- `alice` 是**账号级**冷却（积分用尽），所有模型都不可用
- `bob` 只是**某个模型**被限流，其它模型照常参与轮换

旧的平铺格式仍然兼容：没有 `models` 字段就按账号级冷却处理。

### 安全提示

存档里是**明文的 accessToken / refreshToken**。

- 不要提交到 git
- 不要放到共享目录
- 不要只备份到不加密的位置

> 关于「凭证泄露后能否强制下线」：**不能**。WorkBuddy 服务端只提供账号级吊销（改密码），没有按会话/设备踢人的接口。已实测：客户端退出登录不会吊销已签发的 token，`sid` 不变，token 可无限滑动续期。所以存档文件的保管就是唯一防线。

## 配置

| 环境变量 | 作用 |
|---|---|
| `WORKBUDDY_SWITCHER_DIR` | 覆盖账号库目录 |
| `WORKBUDDY_ELECTRON_BIN` | 指定 WorkBuddy 可执行文件（解密凭据时需要） |

## 排障

### 切换后模型列表没变

`dsh-workbuddy-connect` 有 30 秒的凭据轮询周期。插件切换后会主动触发刷新，但如果失败，等 30 秒即可。也可以点「刷新模型」强制重取。

### 模型分组消失了

几乎一定是存档格式不对。检查文件顶层键名：应该是 `auth` / `account`。如果是 `version` / `credential`，说明是旧格式，重启 DSH 会自动迁移。

### 自动轮换没生效

1. 确认已重启 DSH（Host 侧代码只在启动时加载）
2. 确认卡片里「额度用尽时自动切号」是勾选状态
3. 确认当前是「已选择某个账号」而不是「跟随客户端」——跟随客户端时不轮换，因为 App 的凭据不在账号库里

### 卡在冷却但额度已恢复

点「解除冷却」。

如果标记写的是**模型名**（例如「claude-sonnet-4-5 冷却至 …」），按钮会变成「解除该模型冷却」，
只清掉这个模型的限制，不影响同一账号上其它模型的冷却记录。

### 想确认某个账号是不是整个都不能用了

设置页里看标记：

- **「账号额度 冷却至 …」** → 整个账号被限（积分用尽），换号才有用
- **「模型名 冷却至 …」** → 只有这个模型被限，同账号换用别的模型仍然可以

标记变淡表示这条冷却不影响当前路由的模型。

## 已知限制

- **只在归档账号之间轮换**。如果你选择「跟随客户端」，插件不会自动切走，因为那等于擅自改账号。
- **无法判断账号剩余额度**。`429` 只说明「此刻被限」，不告诉你还剩多少。轮换排序按刷新令牌寿命，不按余额。
- **限流范围靠推断**。上游对「某模型限流」和「积分用尽」可能回同一个 429，
  插件按「消息里有没有积分措辞」区分：有 → 账号级，没有 → 模型级。
  推断不出模型名时会退回账号级（保守）。
- **存档是明文**。见上方安全提示。

## 许可

MIT。见 [LICENSE](./LICENSE)。

## 相关项目

- [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) — 把 WorkBuddy 模型接入 DSH（本插件依赖它）
