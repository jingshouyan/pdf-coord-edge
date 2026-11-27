# 隐私政策 / Privacy Policy

**适用产品**：PDF 坐标查看器（左下角原点 pt）—— Microsoft Edge 扩展
**最后更新**：2026-11-27

## 一句话结论

本扩展**不收集、不存储、不传输任何用户数据**。所有计算都在你自己的浏览器标签页内完成，关闭页面即全部消失。

## 具体说明

### 1. 我们不收集什么

- 不收集姓名、邮箱、设备信息、浏览历史、使用统计
- 不含任何分析代码、埋点、广告 SDK、崩溃上报
- 不连接任何服务器，扩展自身**不发起任何网络请求**

### 2. 你会留在本机的数据

| 数据 | 存在哪 | 何时清除 |
| --- | --- | --- |
| 你的偏好设置（原点角、单位、小数位、缩放、旋转、十字线/刻度尺开关、接管开关） | 浏览器 `chrome.storage.local`，只在本机 | 卸载扩展或手动清除浏览器数据 |
| 你打开的 PDF 内容、鼠标坐标、打点标记 | 仅在查看器页面的内存中 | 关闭或刷新该标签页 |

我们**无法**访问上述任何数据 —— 扩展没有后端，也没有能力把它们发出去。

### 3. 关于文件访问权限

扩展声明了访问本地文件（`file://`）与网页（`http/https`）的权限，唯一用途是：**读取你主动打开的那一个 PDF 文件的字节内容**，交给随扩展一起打包的 pdf.js 在本地解析并渲染坐标。

- 你打开 PDF 之外，扩展不会读取磁盘上任何其他文件
- PDF 内容不会被上传，解析与测量全程在本机内存完成
- 若不需要测本地文件，你可以在 `edge://extensions/` 里关掉「允许访问文件 URL」，此时仍可测量网页中的 PDF 或用「选择文件」按钮手动打开

### 4. 第三方代码

扩展内嵌 [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0 许可，Mozilla 维护），已完整打包进扩展文件中，**不从网络加载任何远程代码**。pdf.js 的行为同样是本地解析，不外发数据。

### 5. 儿童隐私

本扩展不面向儿童，不含任何数据收集行为，因此不适用 COPPA / GDPR 项下的儿童数据条款。

### 6. 政策变更

如果未来版本引入任何数据收集行为，会先更新本页并在扩展商店页面显著说明，同时提高版本号。在此之前本页描述即为最终事实。

## 联系

反馈与问题：请在 Microsoft Edge 加载项扩展页面的「支持」信息处联系发布者，或提交 issue。

---

# Privacy Policy (English)

**Product**: PDF Coordinate Viewer (origin: bottom-left, pt) — Microsoft Edge extension

**Bottom line**: This extension collects, stores, and transmits **no user data**. Everything happens inside your own browser tab.

- **No collection**: no names, emails, device identifiers, browsing history, or analytics. No tracking code, no advertising SDK, no crash reporting. The extension makes **zero network requests** of its own.
- **Local only**: your preferences (origin corner, unit, decimals, zoom, rotation, crosshair/ruler toggles, takeover switch) live in the browser's local storage on your device. PDF content, cursor coordinates, and measurement markers exist only in the page's memory and disappear when the tab closes. We cannot access either — there is no backend.
- **Why file/web access is requested**: solely to read the bytes of the one PDF you choose to open, so the bundled pdf.js can render it locally and compute point coordinates. It never reads any other file on disk, and never uploads document content.
- **Bundled code**: pdf.js (Apache-2.0, maintained by Mozilla) is fully included in the package. No remote code is loaded or executed.
- **Children**: the extension is not directed at children and performs no data collection.
- **Changes**: any future introduction of data collection would be disclosed here and on the store listing, with a version bump.
