# azzip · 无边框毛玻璃 UI 重设计 — 设计文档

**日期**:2026-06-01
**状态**:设计已确认,待写实现计划
**一句话**:把 azzip 主窗口改成无边框、真透明(Win11 Acrylic 毛玻璃)、自定义窗口控件与滚动条的极简高级界面。

---

## 1. 背景与动机

当前 M1 的 UI 能用但不够"极简高级":有应用内标题行、内容表格带边框、用系统默认滚动条、窗口是标准带边框/标题栏的不透明窗口。本次重设计目标是去掉这些"框",让界面尽可能简洁、通透、有高级毛玻璃质感。

**用户诉求(原话归纳):**
- 去掉应用内的标题行(`📦 azzip` 那一行)
- 去掉界面边框和系统默认右侧滚动条
- 把右上角的操作按钮集成进主界面
- 滚动条改成半透明竖向 bar,且**平时隐藏、滚动/悬停才浮现**
- 主界面半透明毛玻璃质感,能看到模糊的背景
- 整体尽可能简洁、高级

---

## 2. 范围

### 本次做(In scope)
- 无边框窗口(去系统标题栏 + 边框)
- 真实窗口透明 + Win11 Acrylic 毛玻璃(透出桌面并模糊)
- 自定义窗口控件:**最小化 + 关闭**(无最大化),含可拖动区
- 两行分层布局:窗口控件行 / 操作行
- 空态(居中欢迎区)与工作态(列表)切换
- 去掉内容边框;自定义半透明紫色滚动条,平时隐藏
- 把窗口控件行抽成独立组件 `TitleBar.tsx`

### 不做(Out of scope / YAGNI)
- 最大化/还原按钮(解压软件极少用)
- macOS/Linux 的毛玻璃实现(仅保留跨平台接口,V1 只做 Windows)
- 改动任何解压核心逻辑(`archive/`、`commands.rs`)
- 现有三种解压方式与下拉菜单的行为变更(完整保留)

### 平台
- V1 目标 Windows 11(当前开发环境)。Acrylic 调用用 `#[cfg(target_os = "windows")]` 隔离,为跨平台预留。

---

## 3. 透明与毛玻璃方案(已确认:真实窗口透明 + Acrylic)

**取舍结论:** 走真实窗口透明 + Win11 Acrylic,而非应用内画装饰背景。透出的是用户桌面/背后窗口,经 Acrylic 模糊 + 紫色染色。

**已知现实(用户已接受):**
- Windows 原生 Acrylic 在拖动窗口时可能有轻微模糊拖影,属系统层限制,不可完全消除。
- 该效果平台相关,Linux 无原生支持;V1 只做 Windows,非当前问题。
- 回退预案:若 Acrylic 效果不理想,可回退到"应用内半透明装饰背景"方案(本次不实现,仅记录)。

---

## 4. 窗口与透明层(技术骨架)

### Tauri 窗口配置(`src-tauri/tauri.conf.json`)
- `decorations: false` — 去系统标题栏和边框
- `transparent: true` — 窗口背景透明
- 保留 `width: 800, height: 600`
- 新增 `minWidth: 480, minHeight: 360` — 防止拖太小导致布局崩坏

### Acrylic 毛玻璃(`src-tauri/src/lib.rs` 的 setup 钩子)
- `Cargo.toml` 显式加入 `window-vibrancy`(当前已是 Tauri 间接依赖)
- 在窗口创建后,于 `.setup(...)` 中获取主窗口并调用 `apply_acrylic(&window, Some((36, 27, 75, 120)))`(半透明紫色染色,具体数值实现期可微调)
- 用 `#[cfg(target_os = "windows")]` 包裹该调用;非 Windows 平台编译为空操作,保留接口
- 若 `apply_acrylic` 返回错误(老版本 Windows 不支持),记录但不致命(界面仍可用,只是少了毛玻璃)

### 前端配合(`src/App.css`)
- `html, body, #root` 背景全部设为 `transparent`
- **移除**原 `body` 上的实心径向渐变背景(否则遮挡 Acrylic)
- 紫粉品牌色改由 Acrylic 染色 + 内容面板半透明毛玻璃共同体现

---

## 5. 界面布局与组件

整体:一块圆角半透明毛玻璃面板浮在透明窗口上,两行分层 + 内容区。

### ① 窗口控件行(顶部,~34px,也是拖动区)
- 左侧:`azzip` 低调小字
- 右侧:`─`(最小化)、`✕`(关闭)两个按钮 —— **无最大化**
- 整行加 `data-tauri-drag-region` 使其可拖动窗口
- 两个按钮加 `-webkit-app-region: no-drag`(或对应属性),否则按钮区域无法点击
- 按钮平时低调(灰紫),悬停明显;`✕` 悬停泛红
- 行为:调用 `@tauri-apps/api/window` 的 `getCurrentWindow().minimize()` / `.close()`
- 抽成独立组件 **`src/TitleBar.tsx`**(职责单一:拖动区 + 最小化/关闭)

### ② 操作行(仅工作态显示)
- 单独一行:左 `Open archive…`,右 `Extract all ▾` 分体按钮
- 完整保留已验证的三种解压方式(选目录 / 解压到同名文件夹 / 解压到此处)及下拉
- 空态时整行隐藏

### ③ 内容区
- **空态**(`archivePath === null`):中央居中欢迎区 —— 📦 图标 + "把压缩包拖到这里" + "打开压缩包"按钮,有呼吸感
- **工作态**:路径行(`📂 <文件名> · N 项`)+ 文件列表

### ④ 自定义滚动条
- 去掉 `.entries` 原来的 `1px` 边框
- 列表容器 `overflow:auto`,用 `::-webkit-scrollbar` 系列自定义:宽 ~6px、半透明紫色、圆角
- **平时隐藏**(thumb 透明),**滚动或悬停时淡入**浮现(`transition` + `:hover`/滚动态)
- 仅内容超出时出现

### 组件拆分(代码组织)
- 新增 `src/TitleBar.tsx`(窗口控件行),避免 `App.tsx` 继续膨胀
- 其余 UI 暂留 `App.tsx`
- 可能需在 `src-tauri/capabilities/default.json` 加 `core:window:default`(最小化/关闭权限)

---

## 6. 影响的文件

- `src-tauri/tauri.conf.json` — decorations/transparent/min 尺寸
- `src-tauri/Cargo.toml` — 显式加 `window-vibrancy`
- `src-tauri/src/lib.rs` — setup 钩子里 apply_acrylic(Windows)
- `src-tauri/capabilities/default.json` — 加 `core:window:default`(如需)
- `src/TitleBar.tsx` — 新增,窗口控件行
- `src/App.tsx` — 两行布局、空态/工作态切换、引入 TitleBar
- `src/App.css` — 透明背景、毛玻璃面板、自定义滚动条、去边框、按钮样式

不改:`src/api.ts`、`src/types.ts`、`src-tauri/src/archive/*`、`src-tauri/src/commands.rs`。

---

## 7. 错误处理与边界

- **Acrylic 不支持的环境**:`apply_acrylic` 出错时记录,不 panic;界面回退为半透明面板(无系统级模糊),仍完全可用。
- **窗口拖太小**:`minWidth/minHeight` 兜底。
- **无边框后无法移动/关闭**:由自定义拖动区 + 最小化/关闭按钮覆盖。
- **拖动区与按钮冲突**:按钮显式 `no-drag`,确保可点击。

---

## 8. 测试策略

UI/窗口效果以**手动验证**为主(自动化测试不适合验证毛玻璃观感、拖动、置顶等):
- 前端 `npx tsc --noEmit` 通过;`npm run build` 通过
- 后端 `cargo build` 通过(Acrylic 调用、capability 编译正确)
- 现有 6 个 Rust 测试仍全绿(本次不碰核心逻辑,作回归确认)
- 手动验证清单:窗口无边框/透明、Acrylic 毛玻璃可见、拖动可移动窗口、最小化/关闭可用、空态欢迎区、打开后两行布局、三种解压仍工作、滚动条平时隐藏滚动时浮现、内容无边框

---

## 9. 难度评估

| 部分 | 难度 | 说明 |
|------|------|------|
| 无边框 + 透明窗口配置 | 低 | Tauri 配置项 |
| Acrylic 毛玻璃 | 中 | window-vibrancy 调用 + 平台隔离;效果受系统限制 |
| 自定义窗口控件 + 拖动 | 低-中 | drag-region + no-drag + window API |
| 两行布局 / 空态切换 | 低 | 纯 React/CSS |
| 自定义隐藏式滚动条 | 低 | webkit scrollbar 伪元素 |

**总体:中低难度,纯展现层 + 窗口配置,无核心逻辑风险。** 主要不确定性在 Acrylic 的实际观感(已有回退预案)。
