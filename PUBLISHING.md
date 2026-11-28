# 发布到 Microsoft Edge 加载项（上架清单）

已为本扩展准备好的东西：

- 上传包：`publish/pdf-coordinate-viewer-1.3.0.zip`（15 个条目，manifest 在根）
- 商店素材：`store-assets/store-logo-300.png`、`promo-small-440x280.png`、`promo-large-1400x560.png`
- 包内图标：`icons/icon16|32|48|128.png`
- 重新打包：改完代码后运行 `make-release.ps1`（会重打版本号同名 zip）

改代码后要重新打包，zip 里是旧副本，不会自动同步。

---

## 步骤 1 · 注册开发者账号（免费）

入口：https://partner.microsoft.com/dashboard/microsoftedge/

Edge 计划**不收取注册费**（Chrome Web Store 是 5 美元，Edge 免费）。

1. 用 Microsoft 账号登录，没有就先建一个
2. 填写 Edge 开发人员注册表单：
   - 账户国家/地区：**China**（要与你实际所在地、后续发票信息一致）
   - 账户类型：个人 / 公司（公司需填审批人）
   - 发布者显示名称：会公开显示在商店页，建议填你希望用户看到的名字
   - 联系人信息、同意开发人员协议
3. 提交后等验证邮件，在 **Microsoft Edge 加载项** 计划下确认注册完成

## 步骤 2 · 创建新扩展并上传 zip

1. 合作伙伴中心 → 主页 → **Edge** 卡片 → 概述页
2. 点 **＋ 创建新扩展**，输入扩展 ID 名称（内部管理用，不对用户显示）
3. 把 `publish/pdf-coordinate-viewer-1.3.0.zip` 拖进 **拖动到此处 (.zip)**
4. 校验通过后，左侧选 **扩展概述** → **程序包** → 查看解析出的名称/版本/权限 → **继续**

> 打包注意：必须在文件夹**内部**选中文件压缩，manifest.json 要位于 zip 根目录；只支持 .zip。

## 步骤 3 · 可用性

- 可见性：`公开`（想让少数人先测就选 `隐藏`，然后只发列表 URL）
- 市场：默认所有市场；只给国内用户可改成仅 **China**
- 保存 & 继续

## 步骤 4 · 属性

- **类别**：生产力工具（Productivity Tools）
- **网站** / **支持联系人详细信息**：可选，但建议填邮箱，否则用户无法反馈
- **成人内容**：不勾

## 步骤 5 · 隐私（照抄即可）

**单一用途说明**

```
本扩展只做一件事：把 Edge 中打开的 PDF 改由内置的 pdf.js 渲染，并在页面上以「每页左下角为原点 (0,0)」实时显示鼠标坐标，单位为 pt，附带打点测距、刻度尺与单位换算（pt/mm/cm/in）。所有计算在本页完成。
```

**权限理由**

| 权限 | 填写的理由 |
| --- | --- |
| `tabs` | 用户点击 .pdf 链接时，需要在当前标签页把该地址切换到扩展自带的坐标查看器；扩展图标弹窗里也提供「用当前标签页的 PDF 打开」入口。仅用于读取标签页 URL 和改写该标签页地址。 |
| `storage` | 保存用户本地偏好：原点角、单位、小数位、缩放、旋转、十字线与刻度尺开关、接管开关。数据只存在本机浏览器，不上传。 |
| `contextMenus` | 提供「用 PDF 坐标查看器打开」右键项，让已在内置阅读器打开的 PDF 能手动切换过来。 |
| `host_permissions: http / https / file` | 需要读取用户指定的 PDF 文件字节流交给 pdf.js 解析；本地 PDF 走 `file://`，网络 PDF 走 `http(s)`。扩展不访问任何其他站点，也不发起任何第三方网络请求。 |

**远程代码**：选 **否**（pdf.js 完整打包在 `lib/` 内，全部随包分发，无任何远程脚本）

**数据使用情况**：全部不勾选 —— 本扩展不收集、不传输任何用户数据，坐标与标记只存在于当前页面内存中。

**隐私政策 URL**：见下一步（本地稿：`PRIVACY.md`）

## 步骤 6 · Microsoft Store 一览（每种语言必填）

点 **编辑详细信息**：

- **扩展名称**：从 zip 的 manifest 自动带出，只读
- **简短说明**：从 manifest `description` 自动带出，只读；要改必须改 manifest 后重新上传 zip
- **说明**：250 ~ 10,000 字符，直接用下面现成文案
- **扩展徽标**（必填）：上传 `store-assets/store-logo-300.png`（1:1，最小 128×128，建议 300×300）
- **小型促销磁贴**（可选）：`promo-small-440x280.png`，必须正好 440×280
- **大型促销磁贴**（可选）：`promo-large-1400x560.png`，必须正好 1400×560
- **屏幕截图**（可选，最多 6 张）：必须正好 **1280×800** 或 **640×480**，尺寸不对传不上去
- **搜索词**（可选）：`PDF 坐标`、`PDF 测量`、`pt 标尺`、`pdf ruler`、`pdf measurement`

由于清单声明了 `default_locale: zh` 且 `_locales/` 下有 zh + en，商店会列出中英两种语言，**两行的说明与徽标都要填**（上传徽标后可用「复制」一次应用到所有语言）。

**说明（中文）—— 直接粘贴**

```
做印前、排版、图纸标注时，经常要确认某个元素距离页面边角多少磅。Edge 自带的 PDF 阅读器不提供坐标，Acrobat 又要装重型软件——本扩展就是为这件事做的轻量工具。

安装后，你在 Edge 里点开任何 PDF（本地文件或网页链接），它会自动接管，用内置的 pdf.js 渲染页面，并实时显示鼠标所在位置的距离读数：以每页左下角为原点 (0,0)，X 向右为正，Y 向上为正，单位是 pt（1 pt = 1/72 英寸）。鼠标旁会浮出读数，顶部状态栏同步显示当前页与页面尺寸。

读数为什么准：不猜屏幕 DPI。扩展对每一页做自标定——从 PDF 文件自身的页面框取得该页在用户空间的 pt 尺寸，再除以它当前渲染出的像素宽度，得到这一页真实的 px/pt 比例。所以不管你放大到 800%、浏览器缩放调到 90%、用 4K 屏还是普通屏，坐标读数都不变。A4 会显示为 595.3 × 841.9 pt，换成 mm 即 210 × 297。

主要功能：
· 实时坐标读数，鼠标跟随浮层 + 状态栏双显示
· 单击打点，连点两次自动给出 ΔX、ΔY 与直线距离，可连打多点依次测量，Esc 清除
· 原点可切换到右下 / 左上 / 右上角，适配不同排版习惯
· 单位在 pt / mm / cm / in 之间一键切换，小数位 0～3 位可调
· 十字准线与页面刻度尺（每 10pt 一格，50pt 标注数值），可作视觉对齐参考
· 支持视图旋转 90/180/270 度，横版图纸也能正常测量
· 多页连续滚动浏览，滚动时自动识别当前页；方向键、PageUp/PageDown 翻页
· Ctrl + 鼠标滚轮即可在页面内缩放（以光标为锚点，20%～800%），不会误触发浏览器整页缩放；触摸板捏合同样适用
· 缩放、适应宽度、页码跳转

隐私：不联网、不收集任何数据、不含广告与统计代码。pdf.js 完整打包在扩展内，不加载任何远程代码。文档内容与测量结果只存在于当前页面的内存里，关闭标签页即消失。

提示：直接双击本地 PDF 需要一次性开启 edge://extensions/ 里本扩展「详情」的「允许访问文件 URL」（商店安装的扩展该开关默认关闭）。不想改设置也可以：把 PDF 拖进查看器任意位置，或点「选择文件」——这两种方式不需要任何权限。
```

**Description (English) — paste as-is**

```
Prepress, layout and drawing work often require checking how far an element sits from a page corner. Edge's built-in PDF viewer shows no coordinates, and Acrobat is a heavy install for such a small job — this extension is the lightweight answer.

Once installed, any PDF you open in Edge (local file or web link) is taken over and rendered with the bundled pdf.js, while live distance readouts follow your cursor. Each page uses its bottom-left corner as origin (0,0): X grows to the right, Y grows upward, and values are in pt (1 pt = 1/72 inch). A floating tag tracks the cursor and the status bar mirrors the current page and page size.

Why the numbers are accurate: nothing is guessed about your display. The extension self-calibrates every page — it reads the page's true pt dimensions from the PDF's own box, divides by the rendered pixel width, and gets that page's actual px/pt ratio. Zoom to 800%, set browser zoom to 90%, or switch to a 4K monitor and the readings stay identical. A4 reports 595.3 x 841.9 pt, or 210 x 297 mm.

Features:
· Live coordinate readout, both a cursor-following tag and a status bar
· Click to drop pins; two consecutive pins give DX, DY and straight-line distance, chain multiple pins to keep measuring, Esc to clear
· Origin movable to bottom-right / top-left / top-right to match different layout habits
· One-click unit switch between pt / mm / cm / in, with 0-3 decimal places
· Crosshair guides and an in-page ruler (tick every 10 pt, labelled every 50 pt) for visual alignment
· View rotation at 90/180/270 degrees for landscape drawings
· Continuous scrolling across pages with automatic current-page detection; arrow keys and PageUp/PageDown to navigate
· Ctrl + mouse wheel zooms inside the viewer (anchored at the cursor, 20%-800%) instead of triggering browser page zoom; pinch gestures work the same way
· Zoom, fit-to-width and jump-to-page

Privacy: no network access, no data collection, no ads or analytics. pdf.js is fully bundled — no remote code is loaded. Document contents and measurements live only in the page's memory and vanish when you close the tab.

Tip: opening a local PDF by double-clicking it requires a one-time switch — enable "Allow access to file URLs" on this extension's Details page in edge://extensions/ (extensions installed from the store have it off by default). If you would rather not change any setting, just drag a PDF anywhere into the viewer or use the "Choose file" button — neither needs that permission.
```

## 步骤 7 · 提交认证

左侧回到 **Microsoft Store 一览**，确认每行状态为 **完成**，右上角 **发布** → 在 **认证说明** 里粘贴下面这段，再点一次 **发布**。

```
测试步骤：
1. 安装后，进入 edge://extensions/ → 本扩展「详情」→ 打开「允许访问文件 URL」（仅"直接双击本地 PDF"这条路径需要；不开也能用拖拽或「选择文件」打开，见第 2 步）。
2. 打开任意 .pdf 文件，会自动跳转到查看器；若未跳转，点扩展图标 →「用当前标签页的 PDF 打开」。若第 1 步未开启权限就打开本地 PDF，查看器会显示引导横幅，此时把 PDF 文件直接拖进页面即可打开。
3. 把鼠标移到页面上：顶部状态栏与跟随鼠标的浮层应显示 X/Y，页面左下角红点处读数应为 0.00 / 0.00，页面正中约为页宽的一半。
4. A4 页面应显示尺寸约 595.3 × 841.9 pt。切换单位为 mm，A4 应约为 210 × 297 mm。
5. 在页面内单击两次，状态栏出现 ΔX / ΔY / 直线距离；按 Esc 清除。
6. 按住 Ctrl 滚动鼠标滚轮：只有 PDF 页面缩放（工具栏百分比同步变化，范围 20%～800%），浏览器整页文字与工具栏不被放大；缩放时光标指向的位置保持不动。
无账号、无登录、无后端服务，不联网，不收集任何数据。
```

认证一般 **7 个工作日内** 完成。通过后商店页状态变为「在 Microsoft Store 中」。

---

## 常见被拒 / 卡住

- **zip 不解析**：manifest 不在根目录、或用了 .rar/.7z。重新跑 `make-release.ps1` 即可。
- **只识别到一种语言**：manifest 的 `name`/`description` 必须是 `__MSG_xxx__` 占位且 `_locales/<lang>/messages.json` 齐全（本包已满足）。
- **要求补隐私政策**：`PRIVACY.md` 已写好，随便挂到一个可公开访问的 URL（GitHub Pages、个人站点都行）再填入。
- **本地 PDF 打不开**：商店安装的扩展「允许访问文件 URL」默认关闭，直接双击打不开属正常。两条解法——开启该开关后点「重试」，或把 PDF 拖进查看器（走 File API，无需该权限）。查看器此时会显示引导横幅，并可选择把该文件交回 Edge 内置阅读器打开。
- **Partner Center 报 `correlationId: undefined`**：清缓存/换 Edge 无痕窗口/换浏览器再提交。

## 后续更新版本

1. 改 `manifest.json` 里的 `version`（如 `1.3.1`）
2. 跑 `make-release.ps1` → 生成新 zip
3. 合作伙伴中心 → 选中该扩展 → **程序包** → 上传新 zip → 保存并发布

## 不经过商店也能分发

给自己或团队几台机器用，不必上架：把 `pdf-coord-edge` 文件夹拷过去，`edge://extensions/` → 开发人员模式 → 加载解压缩的扩展。企业批量分发需要 IT 用组策略（`ExtensionInstallForcelist` + 自托管更新 manifest），走不了商店那条路。

Sources:
- [发布 Microsoft Edge 扩展](https://learn.microsoft.com/zh-cn/microsoft-edge/extensions/publish/publish-extension)
- [注册为 Microsoft Edge 扩展开发人员](https://learn.microsoft.com/zh-cn/microsoft-edge/extensions/publish/create-dev-account)
- [Microsoft Edge 扩展开发人员入口](https://developer.microsoft.com/en-us/microsoft-edge/extensions)
