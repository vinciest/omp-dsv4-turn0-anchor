# omp-pi-anchored-standard

给 **omp**(Oh My Pi)和 **pi**(pi-coding-agent)用的 turn-0 anchor 插件:把目标模型的**第一个请求**锚定到最小工具目录(`bash` + `read`),会话记录到**第一个持久提升信号**(首个 tool call 或 assistant 消息)后恢复完整工具目录。可选(`persona: "minimal"`)在 bootstrap 阶段把系统提示整体替换为 DSH minimal 人设,提升后恢复宿主系统提示。

零配置即可用:默认锚定 DeepSeek V4 Flash/Pro 全家族,不动宿主系统提示。

## 为什么存在

DeepSeek V4 Pro 对 API 可见的工具目录高度敏感。Project2 评测(DeepSeek V4 Pro, `reasoningEffort=max`)中:

| Preset                | Ability (run1/run2) | `let me` 计数 | 工具目录       |
| --------------------- | ------------------: | ------------: | -------------- |
| Standard              |                  91 |           208 | 完整 (25 个)   |
| PTC                   |                  92 |           194 | `run_code`     |
| Minimal               |             99 / 96 |         0 / 0 | 2 个           |
| **Anchored Standard** |         **98 / 99** |     **1 / 0** | 先 2 个,后完整 |

根因是**首请求 scaffold 条件化**:模型的 agentic 后训练对齐到 DeepSeek Harness `minimal` preset 的 turn-0 组合(固定人设 + 两工具 + 无注入上下文 + 受限输出预算);宿主 harness 的宽目录与富系统提示把它推出工作点。两阶段做法:

1. **第一个模型请求** → 只暴露 `bash` + `read`(固定,不配置)。
2. **第一个持久提升信号之后** → 恢复完整目录(能力无损失)。社区两轮实验证明首轮锚定后放开工具面不会立刻丢失轨迹。

> 这是 prompt 条件化实验补丁,不是正确性保证;底层评测是单一私人评测,不是普适结论。无网络请求、无遥测。

## 行为语义

- 提升信号固定为 `either`:首个持久 tool call **或** 首个持久 assistant 消息,先到者为准(纯文本首答不会把会话困在 bootstrap)。
- 失败的 tool call 也算持久信号 → 提升。
- 目录每会话**只变一次**(一次 request-prefix cache 断层)。
- 阶段从**持久会话条目**推导(`getBranch()` / `buildContextEntries()`),`/resume`、`/reload` 自动保留。
- bootstrap 工具在目录里缺失 → **fail-safe**:跳过过滤并告警,绝不静默剥工具。
- 非目标模型完全不受影响;`models` 默认 `["deepseek-v4-flash*", "deepseek-v4-pro*"]`(大小写不敏感前缀通配,覆盖 `deepseek-v4-flash-0731`/`-free`/`deepseek-v4-pro` 及 provider 限定 id),可省略;显式设置整体替换默认值,`models: []` 显式关闭锚定。
- 提升决策按会话 id 在进程内记忆,扫描只做一次。
- **宿主机制不同**(行为一致):omp 侧通过 `pi.setActiveTools()` 原生收窄/恢复活动工具集(`before_provider_request` 的 payload 替换在 openai-completions 传输层被丢弃,不可靠);pi 侧沿用 `before_provider_request` payload 过滤(pi 端口已验证有效)。
- **`persona`(默认 `host`)**:`"minimal"` 时,bootstrap 阶段把系统提示**整体替换**为 DSH minimal 人设(`You are a helpful software engineer assistant.`,与上游 Harness `minimal` preset 逐字节一致)——这是与工具目录同级的轨迹锚点(Flash 的主导变量),提升后恢复宿主系统提示。默认 `"host"` 完全不动宿主系统提示:这是 omp,想要完整 minimal 体验的用户直接用 DeepSeek Harness 即可。omp 经 `before_agent_start` 返回 `systemPrompt` 替换;pi 经 payload 的顶层 `system` / `messages[0]`(role `system`/`developer`)改写。
- **`bootstrapMaxTokens`(默认 `1024`,仅 pi)**:首请求输出预算封顶(上游 issue #6:首请求 `max_tokens` 主导轨迹锚点——1024 复现 `We need` 风格 26/32 次,而适配器默认 256000 是 0/5)。提升后剥离注入的上限,恢复宿主默认。omp 无原生 max-token 控制且 `before_provider_request` 返回值被 openai-completions 传输层丢弃,故此配置在 omp 侧仅做校验、不生效。

## 目录结构

```text
src/
  core.ts   # 共享纯逻辑:toolName / deepMerge / matchGlob / modelMatches / hasToolCallHistory / hasAssistantMessage / isPromoted / filterTools / rewriteSystemPrompt / capMaxTokens / extractRaw / applyDefaults
  omp.ts    # omp 入口:setActiveTools 收窄/恢复 + before_agent_start 替换 systemPrompt + config.yml(YAML)
  pi.ts     # pi 入口:before_provider_request + buildContextEntries() + settings.json
test/
  core.test.ts   # node:test 单测(71 例)
```

## 安装

已发布到 npm(`omp-pi-anchored-standard@0.3.0`)。仓库的 `package.json` 也声明了两个宿主的入口(`omp.extensions` / `pi.extensions`),npm 与 git 安装都会自动加载正确入口。

### omp

npm(推荐):

```sh
omp plugin install omp-pi-anchored-standard
```

或从仓库安装:

```sh
omp plugin install github:Aurzex/omp-pi-anchored-standard
```

> `omp plugin install` 依赖本机 `bun` 命令;没有 bun 时,手动拷进扩展目录即可:
>
> ```sh
> mkdir -p ~/.omp/agent/extensions
> cp -r /path/to/omp-pi-anchored-standard ~/.omp/agent/extensions/omp-pi-anchored-standard
> ```

配置(全局 `~/.omp/agent/config.yml`,或某项目的 `<项目>/.omp/config.yml`)全部可选:

```yaml
anchoredTools:
    models: # 可选;默认 ["deepseek-v4-flash*", "deepseek-v4-pro*"],覆盖 Flash/Pro 全家族
        - deepseek-v4-flash # glob;含 "/" 只匹配 "provider/modelId",裸名两种都匹配
    persona: host # 可选;"host"(默认,不动 omp 系统提示) | "minimal"(bootstrap 阶段整体替换为 DSH minimal 人设,提升后恢复)
    bootstrapMaxTokens: 1024 # 可选;首请求输出预算上限(仅 pi 生效,omp 仅校验)
```

零配置即可用。项目配置深合并覆盖全局:嵌套对象递归合并、**数组整体替换**(不拼接)、项目优先。改完重启 omp。

### pi

npm(推荐):

```sh
pi install omp-pi-anchored-standard
```

或把仓库加进 `~/.pi/agent/settings.json` 的 `packages`,`/reload` 后自动安装:

```jsonc
{ "packages": ["git:github.com/Aurzex/omp-pi-anchored-standard@v0.3.0"] }
```

配置(全局 `~/.pi/agent/settings.json` + 可信项目的 `.pi/settings.json` 覆盖,语义同上)全部可选:

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

> 版本锁:git 安装可用 `@v0.3.0`(pi)/ `#v0.3.0`(omp);npm 安装默认就是 `latest`(`0.3.0`)。

## 验证

会话里跑 `/anchored-tools`,报告当前模型、是否命中目标、persona 模式、当前阶段(`bootstrap` / `promoted (full catalog)` / `not-targeted`)。

首次锚定与系统提示改写会打日志(omp 走 `pi.logger`,pi 走 console):

```
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 2/25 tools (bash, read)
[anchored-tools] deepseek/deepseek-v4-flash: system prompt → DSH minimal persona   # 仅 persona: "minimal"
```

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test(原生 TS,无需 bun;bun 环境同样可跑 node:test)
```

## 已知限制

- **omp** 用 `setActiveTools` 收窄活动工具集,对**所有**传输层生效(含 in-band 方言:方言目录由活动工具生成,空/收窄集合会同步反映到 system prompt 目录块);**pi** 用 `before_provider_request` payload 过滤(pi 端口验证有效,本机未装 pi 无法复测)。
- omp 的 `before_provider_request` payload 替换对 openai-completions 传输(deepseek 等)无效(上游丢弃返回值),故 omp 入口不依赖它。
- `bootstrapMaxTokens` 仅 pi 生效:omp 无原生 max-token setter,且其 `before_provider_request` 返回值被 openai-completions 传输层丢弃(见上),故 omp 只校验该配置、不施加输出预算封顶。
- `persona: "minimal"` 是整体**替换**(不是过滤/裁剪),且只在 bootstrap 阶段生效(提升后恢复宿主系统提示)。它对应的是 DeepSeek Harness 的 `minimal` 模式——需要完整 minimal 体验的用户直接用 dsh 即可;omp 里默认 `persona: "host"` 保留 omp 自己的系统提示。
- `models` 可省略:默认 `["deepseek-v4-flash*", "deepseek-v4-pro*"]`,开箱即锚定 DeepSeek V4 Flash/Pro 全家族(含 `-0731`、`-free`、provider 限定 id)。显式设置整体替换默认值;`models: []` 表示不锚定任何模型。

## License

MIT。概念移植自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)(MIT,本身派生自 DeepSeek Harness Standard preset)与 [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro)(MIT)。与 DeepSeek / pi 项目无关联,未经其背书。
