# 隐患随手拍（手机端 PWA）

零依赖、离线优先的现场拍照 + 189 条清单检查工具，作为「隐患整改文书生成器」的手机前端。
线上地址：https://liu767621407.github.io/hazard-snap/

## 文件职责（3.0 重构后）

| 文件 | 说明 |
|---|---|
| `index.html` | 页面骨架（顶栏、列表、编辑页、清单页、弹层容器） |
| `styles.css` | 基础布局与组件（3.0 之前的样式，保留作底座） |
| `theme.css` | 3.0 主题层：配色、圆角、阴影、卡片/按钮/弹层/清单外观 |
| `app.js` | 业务逻辑：状态、IndexedDB、拍照压缩、隐患编辑、清单、导出、菜单与返回 |
| `core.js` | 通用工具：zip、base64、格式化、哈希等（无 DOM 依赖） |
| `docx.js` | 生成整改通知单 .docx（OOXML，零依赖） |
| `pdf.js` | 生成整改通知单 .pdf（canvas 光栅 + 自研 PDF 封装） |
| `checklist.js` | 189 条清单数据（24 个区域） |
| `sw.js` | Service Worker：预缓存 11 个资源，`snap-3.0.0` 缓存版本 |
| `manifest.webmanifest` / `icon-*.png` | PWA 安装信息与图标 |

## 数据

- IndexedDB：`batches`（检查，含 `checklist.answers`）、`photos`（按 `batchId`/`hazardId` 索引）。
- 本地 `localStorage`：`snap.cfg`（默认单位/检查人/地点等）。
- 导出：`.docx` / `.pdf` / `.zip`（`hazard-snap/1` 数据包）/ `.doc`（189 条清单记录）。

## 与安卓壳的约定

`window.SnapAndroid.appVersion()`、`checkUpdate()`、`shareFile(name, mime, base64)`；
返回键由壳调用 `window.SnapBack()`。

## 开发

```powershell
python -m http.server 8797 --bind 127.0.0.1 --directory snap
```

改完 `app.js` / `styles.css` / `theme.css` 后递增 `WEB_VERSION`（app.js）与 `sw.js` 的 `VERSION`，再发布。
