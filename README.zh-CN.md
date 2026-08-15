# omp-dsv4-turn0-anchor

[English](README.md) | 中文

`omp-pi-anchored-standard` 扩展(`anchored-tools`)的一个 fork,面向 **omp**(Oh My Pi)与 **pi**(pi-coding-agent),包含**经实测验证的 bootstrap-only 人设修复**(针对 DeepSeek V4 Flash/Pro),并把配置面精简到"约定优于配置"。基于上游 `973ca91`;上游此后走向了不同方向,本 fork 有意不跟随(见[与上游的差异](#与上游的差异))。

扩展把目标模型的**第一个请求**锚定到模型训练时对应的 turn-0 scaffold(DeepSeek Harness `minimal` preset),随后把控制权交还宿主:

1. **首请求** - 只暴露 `bash` + `read`(pi 侧输出预算封顶 `bootstrapMaxTokens`,默认 1024)。
2. **第一个持久提升信号之后**(首个 tool call 或 assistant 消息,先到者为准)- 恢复完整工具目录;若设置了 `persona: "minimal"`,宿主系统提示也一并恢复。

零配置即可用:默认锚定 deepseek-v4-flash/pro 全家族,不动宿主系统提示。

## 为什么有这个 fork

社区报告声称 `deepseek-v4-flash-0731` "过拟合" DeepSeek Harness minimal 模式、在 oh-my-pi 里表现异常。调查结论([完整报告](docs/anchored-bootstrap-validation.md)):

- 模型与 harness `minimal` preset 都真实存在;但报告附带的扩展代码是伪造的(`@oh-my-pi/sdk` 在 npm 上不存在)。
- 真正的问题是:minimal 人设是对系统提示的**整体替换**,发布版端口里的 `minimalSystemPrompt: true` 因此丢掉了 omp 的 harness 约定 - 尤其是 `ask` 工具的使用指引。锚定会话把第一个澄清问题写成了散文;对照组用了带结构化选项的 `ask` 工具。
- 在 `deepseek-v4-flash` 上的 A/B(基线:`let me` 出现在 14,663 条思考消息的 54.6% 中):启用 bootstrap-only 人设修复后,锚定会话既产出 `We need` 推理,也发出正确的结构化 `ask` 工具调用 - 这正是 standard preset 想要的轨迹,且 turn 0 之后 omp 的约定不再丢失。
- "But wait" 不是 deepseek 的特征指纹:它是跨模型的(MiMo V2.5 Pro 11.8% vs deepseek 4.7% 的消息占比),且 0731 发布前后频率稳定。

Bootstrap-only 是修复本身,不是折中:minimal 人设只用于第一个未提升请求,提升后恢复宿主系统提示。永久替换(上游的做法)买到的是同样的 turn-0 锚定,却永久丢掉了宿主约定 - A/B 证明这才是真正的失败模式。

## 与上游的差异

### fork 分歧点(`973ca91`)

| 变更 | 上游 | 本 fork |
| --- | --- | --- |
| 人设作用域 | 永久替换 | **Bootstrap-only**:minimal 人设只用于第一个未提升请求,提升后恢复宿主系统提示(经实测的修复) |
| 配置面 | 9 项(`enabled`、`bootstrapTools`、`bootstrapMode`、`promoteOn`、`anchorText`、`notify`、`minimalSystemPrompt`、`models`、`bootstrapMaxTokens`) | **3 项可选配置**:`models`、`persona`、`bootstrapMaxTokens`。bootstrap 工具固定为 `bash`+`read`;提升信号固定为 `either`;零工具模式移除 |
| 配置名 | `minimalSystemPrompt`(暗示"裁剪") | **`persona: "host" \| "minimal"`**,默认 **`"host"`** - 该开关是整体*替换*,而 "minimal" 是 DeepSeek Harness 的模式,不是本扩展的模式。默认不做替换(omp 优先:想要完整 minimal 体验直接用 dsh) |
| 默认模型 | `["deepseek-v4-pro"]` | `["deepseek-v4-flash*", "deepseek-v4-pro*"]` - 大小写不敏感前缀通配,可跨 `/`(匹配 `deepseek-v4-flash-0731`、`-free`、provider 限定 id) |

两个宿主(omp + pi)的配置语义完全一致;pi 侧的人设替换上游也是永久生效,本 fork 同样改为 bootstrap-only。

### fork 分歧点之后(上游 `v0.4.2`)

上游在本 fork 分歧后加入了 task-aware routing,随后又为 "stable We need anchoring" 将其默认关闭。本 fork 保留窄化的 bootstrap-only 修复,不移植 task routing - 逐提交分析与未来上游提交的评估清单见 [docs/upstream-divergence.md](docs/upstream-divergence.md)。

### 身份

包名已从 `omp-pi-anchored-standard` 改为 `omp-dsv4-turn0-anchor`(fork 身份)。扩展名(`anchored-tools`)与配置键(`anchoredTools`)保持不变 - **不要把上游与本 fork 同时安装**(扩展名、配置键相同,后加载者静默生效)。启用其一前,先禁用或卸载另一个。

## 配置

全部可选。全局 `~/.omp/agent/config.yml`(或 `<项目>/.omp/config.yml`,项目级深合并覆盖全局,数组整体替换、不拼接,项目优先):

```yaml
anchoredTools:
    models: # 可选 - 默认 ["deepseek-v4-flash*", "deepseek-v4-pro*"]
        - deepseek-v4-flash # glob;含 "/" 只匹配 "provider/modelId",裸名两种都匹配
    persona: host # 可选 - "host"(默认,不动 omp 系统提示) | "minimal"(bootstrap-only 替换,提升后恢复)
    bootstrapMaxTokens: 1024 # 可选 - 首请求输出上限(仅 pi 生效;omp 仅校验、不施加)
```

`models: []` 显式关闭锚定。改完重启 omp。

pi(`~/.pi/agent/settings.json`,可信项目 `.pi/settings.json` 覆盖,语义同上):

```jsonc
{
	"anchoredTools": {
		"models": ["deepseek-v4-pro"],
		"persona": "host",
		"bootstrapMaxTokens": 1024,
	}
}
```

改完 `/reload`。

## 安装

### omp

插件安装(之后用 `omp plugin enable` / `omp plugin disable` 管理):

```sh
omp plugin install github:vinciest/omp-dsv4-turn0-anchor
```

装完若未启用,手动启用:

```sh
omp plugin enable omp-dsv4-turn0-anchor
```

启用后,扩展在每次会话都会加载,读取 `~/.omp/agent/config.yml`(或 `<项目>/.omp/config.yml`)里的 `anchoredTools` 配置;禁用插件即从会话中完全移除。

每会话替代用法(不做全局注册)- 迭代时用 checkout,插件已装时也可直接指到插件副本:

```sh
omp -e /path/to/omp-dsv4-turn0-anchor/src/omp.ts                                  # fork checkout
omp -e ~/.omp/plugins/node_modules/omp-dsv4-turn0-anchor/src/omp.ts               # 已安装的插件副本
```

插件处于**启用**状态时,请把 `-e` 与 `--no-extensions` 搭配使用,避免同一文件注册两次:

```sh
omp --no-extensions -e ~/.omp/plugins/node_modules/omp-dsv4-turn0-anchor/src/omp.ts
```

插件副本的 `@oh-my-pi/pi-coding-agent` SDK 由 omp 自身运行时解析(已实测),但 `omp plugin uninstall` 会删除该目录 - 需要不随卸载消失的路径请用 checkout。

### pi

```sh
pi install github:vinciest/omp-dsv4-turn0-anchor
```

或加入 `~/.pi/agent/settings.json` 的 `packages` 后 `/reload`:

```jsonc
{ "packages": ["git:github.com/vinciest/omp-dsv4-turn0-anchor"] }
```

> 未发布到 npm;从 git 仓库安装。包名为 `omp-dsv4-turn0-anchor`(扩展本身叫 `anchored-tools`,配置键 `anchoredTools`)。

## 行为

- 提升信号固定为 `either`:首个持久 tool call **或**首个持久 assistant 消息,先到者为准。失败的 tool call 也算持久信号。
- 工具目录每会话**只切换一次**(一次 request-prefix cache 断层)。
- 阶段从**持久会话条目**推导(`getBranch()` / `buildContextEntries()`),`/resume`、`/reload` 自动保留。
- 提升决策按会话 id 在进程内记忆,历史只扫描一次。
- bootstrap 工具在目录中缺失 → **fail-safe**:跳过过滤并告警,绝不静默剥工具。
- 非目标模型完全不受影响。

宿主机制不同(行为一致):omp 通过 `pi.setActiveTools()` 原生收窄/恢复(其 `before_provider_request` 返回值会被 openai-completions 传输层丢弃);pi 在 `before_provider_request` 里过滤 payload。

## 验证

会话里跑 `/anchored-tools`:报告目标模型、persona 模式、当前模型、是否命中、阶段(`bootstrap` / `promoted (full catalog)` / `not-targeted`)。

首次锚定与人设替换会打日志(omp 走 `pi.logger`,pi 走 console):

```
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 2/25 tools (bash, read)
[anchored-tools] deepseek/deepseek-v4-flash: system prompt → DSH minimal persona   # 仅 persona: "minimal" 时
```

## 验证方法

方法、原始数据与会话级证据:[`docs/anchored-bootstrap-validation.md`](docs/anchored-bootstrap-validation.md)。摘要:

- 社区 Project2 证据(私人基准,非普适结论):Pro minimal 99/96 vs standard 91;Flash minimal 92 = opencode 92(风格层面,人设驱动)。
- 杠杆:首轮人设(Flash)、工具 schema(Pro)、首轮 `max_tokens`(1024 复现 `We need` 26/32 次,适配器默认值 0/5)、skill-catalog 注入(9KB 把 81% 翻转为 0%)。
- 四轮 A/B(omp,`/skill:brainstorming` 提示):S1 永久人设 = `We need` 但散文式提问;S2 对照组 = `Let me` + 正确 `ask`;S3 `-p` 模式 = 无效测试面(skill 未注入);S4 bootstrap-only = **`We need` + 结构化 `ask`**,人设恢复后轨迹仍在。
- 基线 `let me`:思考消息的 54.6%(14,663 条);S4 bootstrap 阶段:0。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test(原生 TS)
```

## 已知限制

- 仅在 **omp** 上实测;pi 端口逻辑相同但本机未装 pi(上游 pi 端口在其环境验证过)。
- `bootstrapMaxTokens` 仅 pi 生效:omp 没有原生 max-token setter,且其 `before_provider_request` 返回值被 openai-completions 传输层丢弃,故 omp 只校验、不施加输出上限。
- omp 的 `setActiveTools` 收窄对所有传输层生效,含 in-band 方言(方言目录由活动工具生成)。
- `persona: "minimal"` 只在整个 bootstrap 阶段替换系统提示;它不是过滤或裁剪。要完整 minimal 模式请直接用 DeepSeek Harness。
- 上下文压缩(`context-full` @ 350k)对提升记忆的影响未测试。
- 与上游的分歧是有意为之:task routing(上游 `v0.4.x`)未移植。需要 task-aware routing 请用上游 - 但要接受本 fork 已移除的配置面与永久人设行为。

## License

MIT。概念移植自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)(MIT,本身派生自 DeepSeek Harness Standard preset)与 [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro)(MIT)。与 DeepSeek / pi 项目无关联,未经其背书。
