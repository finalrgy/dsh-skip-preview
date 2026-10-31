# dsh-skip-preview — 维护指南

> 这份文件在每次会话开始时**自动注入**（`AGENTS.md` 由 `dsh-agent-instructions` 加载）。
> 新开一个 cwd 在这个目录的会话，agent 会直接读到它，不需要你重新解释背景。
>
> 详细内容放在 `docs/`，按需读取；这里只保留「必须马上知道」的部分。

## ⚠️ 动手之前：先读通用知识

**凡是涉及改代码、发布、调试、排查加载问题的任务，先读这个文件：**

```
../README.md        （即 ~/own/20_tools/dsh-plugins/README.md）
```

它是 DSH 插件开发的通用知识库，包含**不看就会踩坑**的内容：

- **从 asar 提取 DSH 源码的正确偏移量** —— 用错会读到错位内容，**而且不报错**
- `cordis.patch.yml` 的 `config` **到不了客户端半区**（写了不报错，但读不到）
- 包装服务方法的三个必备细节（幂等标记 / bound original / 还原时校验 identity）
- `link:` 依赖会被 pnpm 重装替换成实体副本，版本悄悄退回
- npm staged publishing 的 `0.0.0-stage` 占位陷阱与 1–3 分钟延迟
- 未经打包的客户端 JS 如何用假 loader 做单元测试
- 发布前的完整检查清单

**为什么单独放外面**：这份知识对下一个插件同样适用，放在单个插件仓库里会腐烂成孤本。
它不会被自动注入（文件名不是 `AGENTS.md`、所在目录也没有 `.git`），所以**必须主动读**。

本文档只覆盖本插件的特有上下文；凡是通用机制，以 `../README.md` 为准。

## 这个插件是什么

按住 ⌘（Windows/Linux 为 Ctrl）点击 DSH 对话里的文件链接，**跳过右侧预览，直接用系统默认应用打开**。
普通点击行为完全不变。

- 仓库：https://github.com/finalrgy/dsh-skip-preview
- npm：https://www.npmjs.com/package/dsh-skip-preview
- 当前版本：**0.1.4**
- 许可：MIT

## 关键事实（省去重新考古）

### 运行与源码是解耦的

DSH 读的是 `~/.dsh/profiles/desktop/node_modules/dsh-skip-preview`（pnpm 从 npm 装的实体目录），
**不读本目录**。所以：

| 动作 | 是否需要重启 DSH |
|---|---|
| 改本目录的源码 | 否（根本没被加载） |
| `npm publish` 新版并 `pnpm update` | **是，必须完全重启**（刷新页面不够） |

发布流程：
```bash
npm version patch --no-git-tag-version
git add -A && git commit -m "..." && git push
npm publish          # 需要能绕过 2FA 的 token，见下
cd ~/.dsh/profiles/desktop && pnpm install   # 或改 package.json 版本号后 pnpm install
```

### 发布需要 token

npm 账号启用了 **staged publishing**，`npm publish` 会要求 2FA，否则 403。
需要一个勾选了 **Bypass 2FA** 的 Granular Access Token（只授权 `dsh-skip-preview` 这一个包的读写）。

安全做法：用临时 userconfig，不写进 `~/.npmrc`：
```bash
TMPRC=$(mktemp /tmp/npmrc.XXXXXX); chmod 600 "$TMPRC"
printf '//registry.npmjs.org/:_authToken=%s\n' '<token>' > "$TMPRC"
npm publish --userconfig "$TMPRC"; rm -f "$TMPRC"
```

发布后 registry 有 **1–3 分钟延迟**才会更新 `dist-tags.latest`，不要立刻判定失败。

### 实现核心：包装服务方法，不碰 DOM

对话里的文件链接有**两种 DOM 形状**：
- Markdown 链接 → `<button class="…_fileLink_…">`
- 行内代码路径 → `<code><button title="…">`

而它们最终都汇到同一个入口：`sidebarRight.openResource(address, options)`。

所以本插件包装这个方法（`lib/client.js`），一处覆盖全部来源，且不受 DSH 改 CSS 类名影响。

**地址格式**：`dsh-resource://file/session/<sessionId>/<path>`
- 工作区内相对路径：`session/s1/notes/a.md`
- 工作区外绝对路径：`session/s1//elsewhere/c.md`（**注意双斜杠**，解析时必须保留前导空段）

**修饰键来源**：`openResource` 只收到地址、拿不到事件，所以在 document 捕获阶段
（`pointerdown` / `click`）记录按键快照，1 秒 TTL。

### 触发键只认一个，按平台判定

`navigator.platform` 匹配 Mac → 认 `metaKey`；否则认 `ctrlKey`。另一个键永远不触发
（macOS 的 Ctrl+点击是系统右键语义，刻意不参与）。

带 Shift / Alt / 另一个修饰键 → 一律不接管，原样交回 DSH 和浏览器。

### 失败必须回退预览

宿主拒绝时（路径不在工作区、文件不存在）Remote 会 **throw** 或返回 `{ok:false}`。
两种都退回 `original(address, options)` 走预览，避免「点了没反应」。
这是实际修过的缺陷，不要退回成只打 console。

## 已知限制（发布时已声明，改动前请确认是否仍成立）

1. **依赖 `sidebarRight.openResource` 这个方法名** — 它是公开服务面，但没有稳定签名契约。
   有启动自检兜底（`selfCheck`），DSH 改名时会 `console.error` 而非静默失效。
2. **手势快照是模块级单例** — 任意点击都会覆盖；1 秒 TTL 缩小了影响但未根除。
   彻底修需绑定到具体事件（约 20 行改动，未做）。
3. **触发键写死** — 无设置项。
4. **可发现性为零** — 界面无提示，全靠记忆。
5. **Windows/Linux 未实测** — 有单测覆盖，没在真机跑过。
6. **不覆盖交付卡片** — `present` 出来的文件走 `ui-deliverables` 自己的路由。

## 元数据易错点（踩过）

- `locale/*.json` 的 **`meta.title` 是插件卡片标题（插件名）**，不是宣传语。
  写成一整句话会让插件列表显示一个段落。当前值：`dsh-skip-preview`。
- `meta.description` 才是介绍文字。
- README 里的图片**必须用绝对 URL**，npm 不解析仓库相对路径，`docs/demo.png` 会变破图。
- 第三方插件**不配 `icon`** —— 图标是 DSH 内置映射，配了也没用。

## 测试方法（不需要真的开浏览器点）

`lib/client.js` 是纯 JS，可以用假 `window.__ModuleLoader__` 加载后直接测：

```js
let def=null;
globalThis.window={__ModuleLoader__:{load:d=>{def=d;}}};
globalThis.document={addEventListener:(t,f)=>L.set(t,f),removeEventListener:()=>{}};
new Function(fs.readFileSync('lib/client.js','utf8'))();
const mod=def.factory(()=>{throw 0});
// 造一个假 ctx 调 mod.apply(ctx)，然后派发 click 事件 + 调 openResource 断言行为
```

已验证 8 条分支：普通点击→预览、⌘→原生、Ctrl(mac)→预览、⌘+Shift→预览、
Ctrl(Win)→原生、⌘(Win)→预览、⌘+Ctrl→预览、Ctrl+Shift(Win)→预览。

**验证发布物**：不要只看本地目录，要 `npm pack <name>@<version>` 下载真实 tarball，
解包后比对内容、跑语法检查、再用临时 profile 启动一次 DSH 确认 bundle 下发。

## 待办 / 未完成

- [ ] **star 数 0**。已发社区帖（https://github.com/deepseek-ai/deepseek-harness/discussions/11646），
      但 awesome-dsh-plugin 的**首页自荐位要求 star > 10**，不够不能提交 PR。
      全量目录（带 `dsh-plugin` topic 自动收录）不受此限，已满足条件等每日刷新。
- [ ] 缺陷 2（手势单例）未修，仅在 README 声明。
- [ ] 交付卡片不覆盖，属功能扩展非缺陷。

## 相关文档

- **`../README.md`** — DSH 插件开发通用知识。**改代码/发布/调试前必读**，见本文开头。
- `docs/decisions.md` — 这个插件做过的决策与踩坑记录（为什么这样选、哪些判断被推翻过）
