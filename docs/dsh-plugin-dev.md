# DSH 插件开发通用知识

> 从开发 `dsh-skip-preview` 的过程中沉淀。适用于任何 DSH Web 客户端插件。
> 内容来自对 `app.asar` 的实际逆向阅读与踩坑，不是文档复述。

## 一、插件的最小结构

一个可发布、可被 DSH 加载的客户端插件需要：

```
my-plugin/
├── package.json          # 含 dsh 字段声明
├── cordis.patch.yml      # bundle 补丁，把插件挂进 profile
├── lib/index.js          # 宿主半区（可为空壳）
├── lib/client.js         # 浏览器半区（真正的逻辑）
├── locale/zh.json        # 插件卡片标题与描述
├── locale/en.json
├── README.md
└── LICENSE
```

### package.json 关键字段

```json
{
  "name": "dsh-my-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./locale/*": "./locale/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "engines": { "dsh": ">=0.2.1-rc.5" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-api-session-controller"],
      "platform": "web"
    }
  }
}
```

- `dsh.bundle.patch` → 指向补丁文件
- `dsh.client.platform: "web"` → 声明这是浏览器插件
- `dsh.client.inject` → **只放包名**，用于模块加载顺序（不是服务名）
- `dsh.engines.dsh` → 插件市场的兼容性判断依据

### cordis.patch.yml

```yaml
- insert:
    - id: my-plugin          # entry id，profile 内唯一
      name: dsh-my-plugin    # 包名
```

## 二、宿主半区与客户端半区

| | 宿主半区 `lib/index.js` | 客户端半区 `lib/client.js` |
|---|---|---|
| 运行位置 | Node（Electron 主进程） | 浏览器 |
| 能做什么 | 注册工具、路由、服务 | 改 UI、包服务、监听事件 |
| 最小形态 | `export function apply() {}` | 见下 |

**如果只改界面行为，宿主半区就是空壳**，`export const name`、`export const inject = []`、`export function apply() {}` 三行即可。

### 客户端半区的包装

```js
window.__ModuleLoader__.load({
  id: "dsh-my-plugin",              // 必须与包名一致
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const inject = ["remote", "remote.session"];   // 服务名，不是包名

    function apply(ctx) {
      ctx.inject(["someService"], (scope) => {
        /* 依赖就绪时执行；返回 disposer 用于清理 */
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

**关键点**：
- 不需要打包工具。手写 JS 即可，靠 `window.__ModuleLoader__` 加载
- `inject`（客户端）里写**服务名**（`remote`、`sessions`、`sidebarRight`）
- `dsh.client.inject`（package.json）里写**包名**，两者完全不同
- `ctx.inject` 的回调返回值会被当作 disposer，依赖变化时会重跑

## 三、服务注入：用 ctx.inject，不要用 ctx.effect

错误做法：
```js
ctx.effect(() => {
  const svc = ctx.sidebarRight;   // 非响应式读取，服务晚到或被替换就失效
});
```

正确：
```js
ctx.inject(["sidebarRight", "sessions"], (scope) => {
  const svc = scope.sidebarRight;
  // 依赖变化时会重跑，返回的清理函数会在重跑前执行
  return () => { /* 还原 */ };
});
```

## 四、包装服务方法的安全姿势

```js
const previous = svc.method;
if (previous[`__${NS}`] === true) return;   // 幂等：热重载不重复包装
const original = previous.bind(svc);

const wrapped = function (a, b) {
  /* 判断是否接管 */
  return original(a, b);   // 不接管时原样交回
};
wrapped[`__${NS}`] = true;

svc.method = wrapped;
return () => {
  if (svc.method === wrapped) svc.method = previous;  // 只还原自己那层
};
```

三个细节缺一不可：**幂等标记**、**bound original**、**还原时校验 identity**。

## 五、配置从哪来（重要陷阱）

**`cordis.patch.yml` 里的 `config` 到不了客户端半区。**

客户端插件由 `loader.create({ name: id })` 创建，`config` 不传给浏览器半区。
写了不会报错，但读不到——比报错更难排查。

真正的配置通道：`ctx.configForms.get(namespace)`，读的是**宿主用户设置文档**，
并在设置页注册 UI（`ui-chat` 的 `linkOpening` 就是这么做的）。

如果只是个人使用，**不如把值写死在代码顶部当常量**，改动 3 行，零复杂度。

## 六、locale 与插件卡片

```json
{
  "meta": {
    "title": "插件显示名",
    "description": "一段介绍文字"
  }
}
```

- **`title` 是卡片标题**，应该是短名字（包名或产品名），**不是句子**
- 写成一整句话会让插件列表显示一个段落，非常突兀
- `description` 才是介绍
- 没配 locale 的插件会回退显示包名

`icon` 字段第三方插件配了也没用——图标是 DSH 内置映射（`ITEM_ARTWORK`），无匹配则用默认图。

## 七、资源地址格式

文件在侧栏中的地址：`dsh-resource://file/session/<sessionId>/<path>`

解析时注意两种形态：
- 工作区内：`session/s1/notes/a.md` → 相对路径
- 工作区外：`session/s1//elsewhere/c.md` → **双斜杠**，前导空段表示绝对路径

构造用 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor(sessionId, cwd, path)`，
解析用 `parseFileAddress(address)`。**不要自己写解析**，容易漏掉双斜杠这种情况。

## 八、获取绝对路径

```js
const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
const abs = path.startsWith('/') ? path : `${cwd}/${path}`;
```

用系统默认应用打开：
```js
await ctx.remote.session.openWorkspacePath({ path: abs });
// Remote 回 {ok, value}；宿主拒绝时会 throw
```

## 九、调试与研究手段

### 从 asar 里读 DSH 源码

```python
import json, struct, os
p = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
f = open(p,'rb'); head = f.read(16)
jlen = struct.unpack('<I', head[12:16])[0]
hdr = json.loads(f.read(jlen).decode('utf-8'))
base = 8 + struct.unpack('<I', head[4:8])[0]   # 注意：不是 8+jlen
```

**踩过的坑**：偏移必须用 `head[4:8]`（pickle header size），不是 `jlen`。
用错了会读出错位的内容，文件头尾被截断，而且**不会报错**——只会得到看不懂的代码。

验证方法：比对 asar header 里的 `integrity.hash` 与提取文件的 SHA-256。

### 不看浏览器也能测客户端逻辑

纯 JS 可以用假的 loader 加载，见 `dsh-skip-preview/lib/client.js` 的测试方式：
假 `window.__ModuleLoader__` + 假 `document` + 假 `ctx`，直接断言行为。

平台判断（`navigator.platform`）也要能打桩：
```js
Object.defineProperty(globalThis, "navigator", { value: {platform}, configurable: true });
```

### 验证 DSH 能否加载插件

```bash
# 1. 组合层
dsh --profile <name> --dump-config | grep -A2 <entry-id>

# 2. 真实启动（用临时 profile + 软链 node_modules，避免污染正式环境）
dsh --profile <tmp> --no-open --port 0

# 3. 确认 bundle 下发：带 token 请求首页，解析 preload URL，下载后 grep 特征字符串
```

## 十、发布流程

### npm 的 staged publishing 陷阱

如果账号启用了 staged publishing，`npm publish` 会有两种表现：

1. **首次发布**：创建一个 `0.0.0-stage` 占位版本（33 字节），真实内容进暂存区
2. **需要 2FA 批准** 才上线

判断是否真的成功：查 `dist-tags.latest` 是否指向你的版本号，**不要只看命令输出**。

registry 有 **1–3 分钟延迟**，`npm publish` 返回成功但 `latest` 还是旧版属正常。

### 发布前的检查清单

- [ ] `node --check lib/client.js`
- [ ] JSON 文件全部 `json.load` 通过
- [ ] `npm pack --dry-run` 看文件清单（确认没漏文件、没带测试文件）
- [ ] README 图片用**绝对 URL**（npm 不解析相对路径）
- [ ] `repository` / `homepage` / `bugs` 填真实地址
- [ ] `files` 字段包含所有要发布的目录
- [ ] 发布后 `npm pack <name>@<version>` 下载真实包验证内容

## 十一、上架到社区目录

**awesome-dsh-plugin** 的收录机制：

| 路径 | 条件 | 说明 |
|---|---|---|
| 全量目录 | 公开仓库 + `dsh-plugin` topic | **自动**，每日刷新，不用提 PR |
| 首页自荐位 | 额外要求 **star > 10** | 需手动提 PR，CI 会校验 star |

加 topic：
```bash
gh api -X PUT repos/<owner>/<repo>/topics -f names[]=dsh-plugin -f names[]=dsh
```

提自荐 PR 时：自荐区最多 30 条，满了要删最旧的；中英文各追加一行到
`SHOWCASE.md`，**不要手改 README 预览区**（由脚本生成）。

## 十二、GitHub 操作

`gh` CLI 在有代理的环境下比 git 更可靠（`api.github.com` 与 `github.com:443` 可能分治）。

推送凭据没配时：
```bash
gh auth setup-git    # 让 gh 的 token 供 git 使用
```

如果 `github.com:443` 超时但 API 通，可以用 Contents API 上传文件：
```bash
gh api -X PUT repos/<owner>/<repo>/contents/<path> --input - <<< "$(jq -n --arg m "msg" --arg c "$(base64 -i file)" '{message:$m, content:$c}')"
```

**注意**：这样会产生**每次一提交**的碎片历史，事后需要整理。
