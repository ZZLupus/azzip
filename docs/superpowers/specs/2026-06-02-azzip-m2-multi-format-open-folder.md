# azzip M2 — 多格式支持 + 解压后打开文件夹 — 设计文档

**日期**：2026-06-02
**状态**：设计已确认，待写实现计划
**一句话**：补齐 7z / TAR / GZ(多种压缩层) 格式支持，加扩展名+魔数双保险路由，并在 UI 加"解压完成后打开文件夹"checkbox。

---

## 1. 背景与动机

M1 只支持 ZIP。M2 目标：覆盖日常绝大多数场景，让用户无需关心格式细节——直接拖进来就能解压。同时加一个高频便捷选项：解压完成后自动在资源管理器里打开目标文件夹。

---

## 2. 范围

### 新增格式（本次做）
| 格式 | 文件后缀 | crate |
|------|---------|-------|
| 7-Zip | `.7z` | `sevenz-rust2` |
| TAR (裸) | `.tar` | `tar` |
| TAR+GZ | `.tar.gz` / `.tgz` | `tar` + `flate2` |
| TAR+BZ2 | `.tar.bz2` / `.tbz2` | `tar` + `bzip2` |
| TAR+XZ | `.tar.xz` / `.txz` | `tar` + `xz2` |
| GZ (单文件) | `.gz` (非 tar) | `flate2` |

### RAR
遇到 `.rar` 文件返回 `ArchiveError::Unsupported("RAR 解压暂不支持，敬请期待")` — 友好提示，不崩溃。RAR 的 C 绑定稳定性问题待确认后在 M2.5 再加。

### 打开文件夹
解压完成后可选自动打开目标目录（Windows 资源管理器）。通过 `@tauri-apps/plugin-opener` 前端 JS API 实现，不新增 Tauri 命令。

### 不做（YAGNI）
- RAR 解压
- checkbox 状态跨会话持久化（localStorage/配置文件）
- 进度完成动画 / toast
- 创建压缩包（M3）
- 密码支持（M4）

---

## 3. 后端架构

### 现有结构（不变）
```
src-tauri/src/archive/
├── mod.rs      ← ArchiveHandler trait + ArchiveEntry/Progress/ArchiveError (不改)
└── zip.rs      ← ZipHandler (不改)
```

### 新增文件
```
src-tauri/src/archive/
├── sevenz.rs   ← SevenZHandler
├── tar.rs      ← TarHandler (统一处理 .tar/.tar.gz/.tar.bz2/.tar.xz)
└── router.rs   ← get_handler(path) 格式路由
```

### 新增 Cargo 依赖
```toml
sevenz-rust2 = "0.6"     # 7z 读取，纯 Rust
tar = "0.4"               # TAR 读取
flate2 = "1"              # GZ 解压
bzip2 = "0.4"             # BZ2 解压
xz2 = "0.1"               # XZ 解压
```
> 注：具体版本在实现期以 `cargo add` 拉取的最新稳定版为准。

### SevenZHandler（`archive/sevenz.rs`）

实现 `ArchiveHandler` trait：
- `list`：用 `sevenz_rust::Archive::open` 读取条目列表，返回 `Vec<ArchiveEntry>`
- `extract`：用 `sevenz_rust::decompress_file` 或逐条目解压，调用 `on_progress` 回调

### TarHandler（`archive/tar.rs`）

构造时接受一个 `Compression` 枚举（`None` / `Gz` / `Bz2` / `Xz`），在内部按类型包裹对应解码器：
```rust
pub enum TarCompression { None, Gz, Bz2, Xz }
pub struct TarHandler(pub TarCompression);
```
`list` 和 `extract` 先把文件流包进对应解码器，再送入 `tar::Archive`。zip-slip 防护：只解压 `entry.path()` 不含 `..` 的条目（`path.components()` 不含 `ParentDir`），否则跳过。

### 格式路由（`archive/router.rs`）

```rust
pub fn get_handler(path: &Path) -> Result<Box<dyn ArchiveHandler + Send>, ArchiveError>
```

**两步路由：**

**第一步 — 扩展名预筛**（不区分大小写）：

| 扩展名 | Handler |
|--------|---------|
| `.zip` | `ZipHandler` |
| `.7z` | `SevenZHandler` |
| `.tar` | `TarHandler(None)` |
| `.tar.gz` / `.tgz` | `TarHandler(Gz)` |
| `.tar.bz2` / `.tbz2` | `TarHandler(Bz2)` |
| `.tar.xz` / `.txz` | `TarHandler(Xz)` |
| `.gz` (非 tar) | `TarHandler(Gz)` — 单文件 GZ |
| `.rar` | `Err(Unsupported("RAR 解压暂不支持，敬请期待"))` |
| 其他/无扩展名 | 进第二步 |

**第二步 — 魔数兜底**（读文件头最多 8 字节）：

| 魔数 | 格式 |
|------|------|
| `PK\x03\x04` (4B) | ZIP |
| `7z\xBC\xAF\x27\x1C` (6B) | 7z |
| `\x1F\x8B` (2B) | GZ |
| `BZh` (3B) | BZ2 |
| `\xFD7zXZ\x00` (6B) | XZ |
| 不匹配 | `Err(Unsupported("无法识别的文件格式"))` |

### `commands.rs` 改动（最小化）

移除：
```rust
use crate::archive::zip::ZipHandler;
```

替换两处 `ZipHandler.list(...)` / `ZipHandler.extract(...)` 为：
```rust
use crate::archive::router::get_handler;
// list_archive:
let handler = get_handler(&archive).map_err(|e| e.to_string())?;
handler.list(&archive)...
// extract_archive:
let handler = get_handler(&archive).map_err(|e| e.to_string())?;
handler.extract(&archive, &dest, &mut |p| { ... })...
```

DTO、异步结构、事件名、命令名全部不变。

### mod.rs 改动

仅加模块声明：
```rust
pub mod sevenz;
pub mod tar;
pub mod router;
```

---

## 4. 前端改动

**文件：`src/App.tsx`（仅工作态部分）**

新增 state：
```ts
const [openAfterExtract, setOpenAfterExtract] = useState(false);
const lastDestRef = useRef<string | null>(null);
```

`runExtract` 函数在调用 `extractArchive` 前记录目标路径：
```ts
lastDestRef.current = dest;
```

新增 `useEffect` 监听 `progress`，完成时打开文件夹：
```ts
useEffect(() => {
  if (!done || !openAfterExtract || !lastDestRef.current) return;
  openPath(lastDestRef.current).catch(() => {});
}, [done, openAfterExtract]);
```

`openPath` 来自 `@tauri-apps/plugin-opener`（已安装，已有 `opener:default` capability）。

在 actions-row 加 checkbox（右侧，Extract 按钮旁）：
```tsx
<label className="open-folder-toggle">
  <input
    type="checkbox"
    checked={openAfterExtract}
    onChange={e => setOpenAfterExtract(e.target.checked)}
  />
  Open folder after extract
</label>
```

**CSS（`App.css`）**：加 `.open-folder-toggle` 样式，与现有毛玻璃风格一致（小字、低调、自定义 checkbox accent 色用品牌紫色）。

**`src/api.ts`**：加一行 import（`openPath` from `@tauri-apps/plugin-opener`）并导出，或直接在 App.tsx 里引入。

---

## 5. 影响文件汇总

**新增：**
- `src-tauri/src/archive/sevenz.rs`
- `src-tauri/src/archive/tar.rs`
- `src-tauri/src/archive/router.rs`

**修改：**
- `src-tauri/Cargo.toml` — 加 5 个 crate
- `src-tauri/src/archive/mod.rs` — 加 3 个 mod 声明
- `src-tauri/src/commands.rs` — 替换硬编码 ZipHandler 为路由调用
- `src/App.tsx` — 加 openAfterExtract state + lastDestRef + checkbox + useEffect
- `src/App.css` — 加 `.open-folder-toggle` 样式

**不改：**
- `src-tauri/src/archive/mod.rs` 的 trait / 类型定义（只加模块声明）
- `src-tauri/src/archive/zip.rs`
- `src/api.ts`（可选：加 openPath 导出；或直接在 App.tsx import）
- `src/TitleBar.tsx`、`src/types.ts`
- capabilities、tauri.conf.json、lib.rs

---

## 6. 错误处理

| 场景 | 行为 |
|------|------|
| `.rar` 文件 | `Unsupported("RAR 解压暂不支持，敬请期待")` → 前端红色错误行 |
| 未知格式 | `Unsupported("无法识别的文件格式")` → 同上 |
| 7z 解压失败 | 映射到 `InvalidArchive(msg)` → 前端显示 |
| TAR zip-slip | 跳过 `..` 路径条目，不中断，继续解其他 |
| `openPath` 失败 | 静默忽略（`.catch(() => {})`) — 文件夹打开失败不影响解压结果 |

---

## 7. 测试策略

**新增 Rust 单元测试（TDD，各 handler 一套）：**
- `SevenZHandler`：构造小 .7z 测试包，验证 `list` 返回正确条目，`extract` 写出文件，损坏包返回 `InvalidArchive`
- `TarHandler`：对 `.tar`、`.tar.gz`、`.tar.bz2`、`.tar.xz` 各准备测试包，验证同上；另加 zip-slip 测试（含 `..` 路径条目被跳过）
- `router`：测试各扩展名路由到正确 handler，`.rar` 返回 `Unsupported`，魔数识别测试（构造裸字节文件）

**前端：**
- `npx tsc --noEmit` 通过
- `npm run build` 通过
- 手动验证：checkbox 勾选后解压完成自动打开资源管理器；不勾选则不打开；三种解压方式（选目录/同名文件夹/此处）均正确记录 `lastDest`

**回归：**
- 现有 6 个后端测试仍全绿（ZIP handler 和 trait 测试不受影响）

---

## 8. 难度评估

| 部分 | 难度 | 说明 |
|------|------|------|
| SevenZHandler | 中 | sevenz-rust2 API 需确认，逐条目解压逻辑 |
| TarHandler (多压缩层) | 中 | 统一 Compression 枚举，流式嵌套解码器 |
| 格式路由 | 低 | 查表 + 魔数匹配，逻辑简单 |
| commands.rs 路由替换 | 低 | 2行改动 |
| 前端 checkbox + openPath | 低 | 纯 React state + 现有 API |

**总体：中低难度。** 核心不确定性在 `sevenz-rust2` 的具体 API（逐条目解压接口），实现期以实际版本文档为准。
