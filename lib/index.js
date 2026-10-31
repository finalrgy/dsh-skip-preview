/**
 * dsh-skip-preview — 宿主半区。
 *
 * 这个插件要改的行为全在浏览器端（按住 ⌘ 点文件链接那一下），宿主侧不需要注册
 * 任何工具、路由或服务：用系统默认应用打开走的是已有的 `session.openWorkspacePath`
 * Remote。所以这里只提供一个合法的空插件，让 bundle 能被宿主加载。
 */

export const name = "dsh-skip-preview";

/** 宿主侧不依赖任何服务。 */
export const inject = [];

/** 宿主侧无操作。 */
export function apply() {}
