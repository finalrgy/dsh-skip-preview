# 未采纳：改动对比卡片的 ⌘+点击

> 状态：**已评估，放弃实现**
> 日期：2026-10-31
> 结论：这张卡片上按 ⌘ 该做什么没有确定答案，硬做出来会更让人困惑。

## 起因

用户反馈：在某次会话末尾的「已编辑 AGENTS.md +25 −2」卡片上按住 ⌘ 点击，没有跳转到系统默认应用。

此前 `AGENTS.md` 里写着「不覆盖交付卡片」，但那条结论是基于**只看了 `openResource`** 得出的，
没有查这张卡片走哪条路径。所以先要搞清事实。

## 调查过程（含两次错误判断）

### 判断 1（错）：以为要包 `openResourceIn`

查 `ui-deliverables` 发现有两个入口：

```js
openResource(address, options)          // 正文、文件树
openResourceIn(sessionId, address, options)   // Tab 域内部
```

在改动对比 Tab 里找到这段：

```js
onClick: () => { tab.actions.openResource(fileAddressFor(sessionId, cwd, file.path)); }
```

`tab.actions.openResource` 内部调的是 `navigator.openResourceIn(...)`。
于是判断「卡片走 `openResourceIn`，需要补包它」。

**实测失败**：包了 `openResourceIn` 之后，在那张卡片上 ⌘+点击依然无反应。

### 判断 2（对）：真正的原因是地址 scheme 不同

回头去读 `ChangedFiles` 组件的实现，发现卡片头部的点击是：

```js
onClick: () => { openReview(0); }
   ↓
openChangesReview({sessionId, seq, turn}, index)
   ↓
ctx.sidebarRight.openResource(changesReviewAddress({sessionId, seq, turn}))
   ↓
"dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>"
```

**走的是 `openResource`（已包装），但地址不是 `file/` 前缀。**

而解析器第一行就把它挡掉了：

```js
const FILE_PREFIX = "dsh-resource://file/";
if (!address.startsWith(FILE_PREFIX)) return null;
```

所以从一开始就没有接管过，和 `openResourceIn` 毫无关系。

## 为什么放弃，而不是继续实现

### 1. 地址里没有文件名

`changes-review` 地址只有 `sessionId/seq/turn` 三段。卡片展示的是**这一轮改动的所有文件**，
`+25 −2` 是汇总。要「用默认应用打开」，得先回答：**打开哪一个？**

单文件时还能猜，多文件时无解。要么只支持单文件（行为不一致），要么弹选择框（交互变重）。

### 2. 卡片语义是「看改了什么」，不是「打开某个文件」

这张卡片的固有动作是打开**并排 diff 视图**。按 ⌘ 的合理延伸应该是
「在外部工具里看这份 diff」（如 VS Code 的 diff 视图），而不是「打开 AGENTS.md」。

两者差别很大：前者需要把 diff 内容导出给外部工具，后者只是打开文件。

### 3. 用户最初的需求已被满足

最初的场景是「对话正文里的文件链接，⌘+点击用默认应用打开」。这条路径一直正常。
改动卡片是后来发现的边角，且语义模糊。

**判断：为一个语义不清晰的位置增加行为，风险大于收益。**

## 附带修正的两条旧结论

调查过程中发现此前文档里的两条说法不准确：

| 旧说法 | 实际情况 |
|---|---|
| 「不覆盖交付卡片（`present` 出来的文件）」 | **错**。交付卡片走 `openFile` → `openResource`，⌘ 有效（实测） |
| 「包 `openResourceIn` 就能覆盖改动对比 Tab」 | **错**。那个 Tab 内部按钮确实走 `openResourceIn`，但卡片本体走 `openResource` + 非 file 地址 |

两条都已在 `AGENTS.md` 里改正。

## 如果将来要做，从哪开始

1. 先确认 `changes-review` 地址能否反查出具体文件列表
   （可能需要向 Host 查 `loadChangesSummary`，或读 `workspace/changes` 事件对应的 diff）
2. 明确多文件时的交互（弹窗？只支持总数=1 的情况？）
3. 考虑是否干脆换个入口——比如在对比页里给每个文件加「用默认应用打开」按钮，
   而不是劫持卡片的 ⌘

## 过程中的额外发现：卡片为什么会「消失」

排查时用户报告「重启后卡片不见了」，一度怀疑是插件导致。实际原因：

- 卡片数据来自 Host **现查的工作区 diff**（`workspace/changes` 事件只记 `turn` 编号，不含文件列表）
- 重启后重新计算，若改动已提交或已清理，diff 为空 → 卡片不显示
- 所以卡片反映的是**当前未提交的改动**，不是历史记录

**这解释了「时有时无」，与插件无关。**

### 由此得到的验证方法教训

想复现卡片，正确顺序是：

```
1. 装好插件
2. 重启 DSH          ← 必须在改动之前
3. 制造文件改动（不提交）
4. 卡片出现，测试
```

反过来（先改文件再重启）会自己抹掉证据——这是我第一次测试失败的原因。