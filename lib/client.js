/**
 * dsh-skip-preview — 客户端半区。
 *
 * 背景：会话正文里的文件链接（Markdown 的 `[a.md](a.md)`、行内代码路径）点击后
 * 都汇到 `sidebarRight.openResource(dsh-resource://file/session/<id>/<path>)`，
 * 一律在右侧 Sidebar 预览，没有修饰键分支。而「用系统默认应用打开」的通道宿主
 * 早就有了：`session.openWorkspacePath({ path })`（文档预览标题栏的「打开」用的就是它）。
 *
 * 所以本插件在服务层包一层 `openResource`：按住 ⌘（Windows 为 Ctrl）点击时，把
 * 会话文件地址解析成绝对路径，改走 `openWorkspacePath`，不打开预览；其余情况原样
 * 交回原实现。
 *
 * 为什么用服务层而不是 DOM 选择器：正文文件链接是 `<button class="…fileLink">`，
 * 行内代码路径是 `<code><button title=…>`，两套 DOM 形状；而它们最终都经过同一个
 * `openResource`，包这一处就覆盖全部入口，也不怕 DSH 改样式类名。
 *
 * 修饰键状态取自 document 捕获阶段的真实事件 —— 它早于 React 在根容器上的冒泡
 * 监听执行，所以 `openResource` 被调用时读到的一定是「这一下」的按键状态。
 */

window.__ModuleLoader__.load({
  id: "dsh-skip-preview",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const NS = "dsh-skip-preview";

    /** 需要的客户端服务：Remote 调用原生打开；sessions 与 sidebarRight 在 apply 内按需注入。 */
    const inject = ["remote", "remote.session"];

    /** `dsh-resource://file/` 地址前缀，与 ui-sidebar-right 的地址语法一致。 */
    const FILE_PREFIX = "dsh-resource://file/";

    /** 绝对路径的样子：POSIX 根、Windows 盘符或 UNC。 */
    const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

    /** Windows 风格 cwd 的判定，用来决定拼接分隔符。 */
    const WINDOWS_PATH = /^[A-Za-z]:[\\/]|^\\\\/;

    /** 手势快照的有效期：程序化触发的 openResource 不该被很久以前的按键影响。 */
    const GESTURE_TTL_MS = 1000;

    /**
     * 这台机器的触发键是不是 `event.metaKey`（macOS 的 ⌘）。
     *
     * 只认一个键，且按平台判定：macOS 上就是 ⌘，Windows/Linux 上没有 ⌘ 键，
     * 对应的是 Ctrl。这样「⌘ + 点击」在 mac 上不会因为顺带接受 Ctrl 而多出触发面
     * —— macOS 的 Ctrl+点击会被系统解释成右键，本就不该被我们接管。
     * @returns 触发键是否落在 metaKey 上。
     */
    const TRIGGER_IS_META = (() => {
      const platform = typeof navigator === "undefined" ? "" : String(navigator.platform ?? "");
      return /Mac|iPod|iPhone|iPad/.test(platform);
    })();

    /**
     * 最近一次点击的修饰键快照。
     *
     * `openResource` 只收到地址、拿不到事件，所以在捕获阶段把真实按键记下来由它消费。
     */
    const gesture = { trigger: false, other: false, at: 0 };

    /**
     * 记下这一下点击的修饰键。
     * @param event - 任意鼠标/指针事件。
     */
    function recordGesture(event) {
      gesture.trigger = TRIGGER_IS_META ? event.metaKey === true : event.ctrlKey === true;
      // 带别的修饰键时不接管：这一下原样留给 DSH 与浏览器自己处理。
      gesture.other = event.shiftKey === true || event.altKey === true
        || (TRIGGER_IS_META ? event.ctrlKey === true : event.metaKey === true);
      gesture.at = Date.now();
    }

    /**
     * 当前手势是否请求「用系统默认应用打开」——只判断，不消费。
     *
     * 判定放在决定处理之后再消费，避免非文件资源（如 `dsh-resource://browser/…`）
     * 白白吃掉一次点击的按键状态。
     * @returns 这一下是否命中。
     */
    function isGestureHit() {
      const fresh = Date.now() - gesture.at <= GESTURE_TTL_MS;
      return fresh && gesture.trigger && !gesture.other;
    }

    /**
     * 让当前手势失效：一次点击只驱动一次打开，避免残留状态影响后续程序化调用。
     */
    function clearGesture() {
      gesture.at = 0;
    }

    /**
     * 把会话文件地址读回 `{ sessionId, path }`，不解析 `.` 与 `..`。
     *
     * 地址有两种形态：工作区内文件存相对段（`session/s1/notes/a.md`），工作区外的
     * 绝对路径保留一个空的首段（`session/s1//elsewhere/c.md`，见 `fileAddressFor`）。
     * @param address - `dsh-resource://file/session/<sessionId>/<path>`。
     * @returns 解析结果；不是会话文件地址时返回 null。
     */
    function parseSessionFileAddress(address) {
      if (typeof address !== "string" || !address.startsWith(FILE_PREFIX)) return null;
      const end = address.search(/[?#]/);
      const rest = address.slice(FILE_PREFIX.length, end === -1 ? void 0 : end);
      const parts = rest.split("/");
      if (parts[0] !== "session") return null;

      const rawId = parts[1];
      const segments = parts.slice(2);
      if (rawId === undefined || rawId === "" || segments.length === 0) return null;

      // 恰好一个前导空段 = 绝对路径；其余空段是畸形地址。
      const absolute = segments[0] === "" && segments.length > 1;
      const body = absolute ? segments.slice(1) : segments;
      if (body.length === 0 || body.some((segment) => segment === "")) return null;

      try {
        const decoded = body.map((segment) => decodeURIComponent(segment));
        const path = absolute ? `/${decoded.join("/")}` : decoded.join("/");
        return { sessionId: decodeURIComponent(rawId), path };
      } catch (_error) {
        return null;
      }
    }

    /**
     * 把工作区相对路径拼成宿主机绝对路径；本来就是绝对路径时原样返回。
     * @param cwd - 会话工作区根目录，可能未知。
     * @param path - 相对或绝对路径。
     * @returns 绝对路径；需要拼接却没有 cwd 时返回 null。
     */
    function resolveToAbsolute(cwd, path) {
      if (ABSOLUTE_PATH.test(path)) return path;
      if (cwd === undefined || cwd === "") return null;
      const separator = WINDOWS_PATH.test(cwd) && cwd.includes("\\") ? "\\" : "/";
      return `${cwd.replace(/[/\\]+$/, "")}${separator}${path.replace(/^[/\\]+/, "")}`;
    }

    /**
     * 交给宿主用系统默认应用打开一个绝对路径。
     *
     * 宿主拒绝时（路径不在工作区、文件不存在）Remote 会 throw；另外也可能正常返回
     * 一个 `ok: false` 的结果，两种都当作失败向上抛，交给调用方回退预览。
     * @param ctx - 客户端上下文。
     * @param path - 宿主机绝对路径。
     * @throws 当宿主没有受理这次打开时。
     */
    async function openWithDefaultApp(ctx, path) {
      const result = await ctx.remote.session.openWorkspacePath({ path });
      // Remote 正常形状是 `{ ok, value }`；直接调用时也可能只拿到 `{ opened }`。
      const accepted = result?.ok === true || result?.opened === true || result?.value?.opened === true;
      if (!accepted) throw new Error("host declined to open the path");
    }

    /**
     * 启动自检：确认插件依赖的宿主接口仍然存在且形状符合预期。
     *
     * 本插件包装的是 `sidebarRight.openResource` 这个方法名——它是 DSH 的公开服务面，
     * 但不是稳定的 API 契约。DSH 升级后若重命名或改变签名，插件会静默失效（点了没反应，
     * 用户不知道原因）。所以在这里显式检查一次，把「静默失效」变成「明确的控制台报错」。
     * @param scope - 已注入 sidebarRight 与 sessions 的作用域上下文。
     * @returns 通过返回 null，否则返回一条人类可读的失败原因。
     */
    function selfCheck(scope) {
      const sidebarRight = scope.sidebarRight;
      const sessions = scope.sessions;

      if (typeof sidebarRight?.openResource !== "function") {
        return "sidebarRight.openResource 不存在——DSH 可能改了方法名，插件需要适配";
      }
      if (typeof sessions?.list?.getSnapshot !== "function") {
        return "sessions.list.getSnapshot 不存在——无法定位会话工作目录";
      }
      if (typeof scope.remote?.session?.openWorkspacePath !== "function") {
        return "remote.session.openWorkspacePath 不存在——宿主没有提供原生打开能力";
      }
      return null;
    }

    /**
     * 客户端插件主体：包装 Sidebar 的资源打开入口，并监听修饰键。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      // sessions 与 sidebarRight 用 ctx.inject 等：它们是服务，可能晚于本插件就绪，
      // 也可能被替换；注入回调在依赖变化时会重跑，包装因此始终挂在当前实例上。
      ctx.inject(["sidebarRight", "sessions"], (scope) => {
        const failure = selfCheck(scope);
        if (failure !== null) {
          // 用 error 而不是 warn：这是插件完全失效，不是降级。
          console.error(
            `[${NS}] 启动自检失败，插件未生效：${failure}\n` +
            `  受影响行为：⌘/Ctrl + 点击文件链接不会用系统默认应用打开（仍走右侧预览）。\n` +
            `  处理建议：升级或卸载 dsh-skip-preview，或向插件作者反馈。`
          );
          return;
        }

        const sidebarRight = scope.sidebarRight;
        const sessions = scope.sessions;

        const previous = sidebarRight.openResource;
        // 已经是本插件的包装（热重载重复 apply）就不再套一层。
        if (previous[`__${NS}`] === true) return;

        const original = previous.bind(sidebarRight);

        const wrapped = function openResource(address, options) {
          // 先判断这一下是不是「⌘ + 会话文件地址」；不是就完全不碰手势状态。
          if (!isGestureHit()) return original(address, options);

          const file = parseSessionFileAddress(address);
          if (file === null) return original(address, options);

          const cwd = sessions.list.getSnapshot().byId[file.sessionId]?.cwd;
          const absolute = resolveToAbsolute(cwd, file.path);
          if (absolute === null) {
            console.warn(`[${NS}] 取不到会话工作区目录，退回预览：`, address);
            return original(address, options);
          }

          // 确认要接管之后才消费手势：非文件资源的点击不会白白吃掉按键状态。
          clearGesture();

          openWithDefaultApp(ctx, absolute).then(
            () => {},
            (error) => {
              // 失败时退回预览，而不是静默什么都不发生：用户至少能看到文件内容，
              // 或者从预览自己的报错里知道「文件不存在 / 不在工作区」。
              console.warn(`[${NS}] 原生打开失败，退回预览：`, absolute, error);
              original(address, options);
            }
          );
          return undefined;
        };
        wrapped[`__${NS}`] = true;

        sidebarRight.openResource = wrapped;
        console.info(`[${NS}] 已接管：⌘/Ctrl + 左键点文件链接 = 系统默认应用打开`);

        return () => {
          // 只还原自己那一层，别踩掉别人后来的包装。
          if (sidebarRight.openResource === wrapped) sidebarRight.openResource = previous;
        };
      });

      ctx.effect(() => {
        const record = (event) => recordGesture(event);
        const clear = () => {
          gesture.at = 0;
        };
        // 捕获阶段早于 React 根容器的冒泡监听，读到的是这一下真实的按键状态。
        document.addEventListener("pointerdown", record, true);
        document.addEventListener("click", record, true);
        document.addEventListener("keyup", clear, true);
        document.addEventListener("pointercancel", clear, true);
        return () => {
          document.removeEventListener("pointerdown", record, true);
          document.removeEventListener("click", record, true);
          document.removeEventListener("keyup", clear, true);
          document.removeEventListener("pointercancel", clear, true);
        };
      }, `${NS}: modifier snapshot`);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
