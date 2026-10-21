# SVG 文本查看器

一个**纯前端、零依赖、无需构建**的 SVG 查看工具：上传 SVG 后可平移、缩放，并点击图中的文字提取完整文本。既支持标准 `<text>` / `<tspan>`，也支持 draw.io「HTML 标签」导出的 `<foreignObject>` 文字。内置港口 EFD 示例图，直接打开即可试用。

---

## 快速运行

**方式一：直接打开（已验证可用）**

双击 `index.html`，Chrome / Edge 会以 `file://` 方式加载。内置示例、拖拽上传、点击提取、复制均可用，不需要网络。

**方式二：本地静态服务器（推荐）**

```bash
cd svg-text-viewer
python -m http.server 5173
# 浏览器访问 http://localhost:5173
```

> 浏览器要求：Chrome / Edge 90+、Firefox 90+、Safari 15+。未使用任何第三方库。

---

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 上传 | 顶部按钮 / 空状态按钮 / 拖拽到页面任意位置；仅接受 `.svg`，限制 25 MB，读取后立即渲染 |
| 左右分栏 | 左侧 SVG 画布，右侧「文本标签」面板；窄屏自动上下堆叠 |
| 平移缩放 | 鼠标拖拽平移、滚轮以光标为锚点缩放、`+ / − / 适应窗口` 控件、缩放百分比显示 |
| 矢量清晰 | 不缩放 DOM，而是改写 SVG `viewBox`，每次缩放由浏览器重新栅格化矢量 |
| 文字提取 | 点击文字，右侧显示完整文本；支持 `<text>` / `tspan` 多行、嵌套子元素、`<use>` 复用，以及 `<foreignObject>` 内的 HTML 标签 |
| 换行处理 | 文本面板可勾选「连接换行」；勾选后显示「替换为空格」，显示文本、字数统计与复制内容同步更新 |
| 高亮反馈 | 独立覆盖层绘制虚线选框，不修改原 SVG；点击空白 / `Esc` 清空 |
| 坐标兼容 | `viewBox`、任意 `transform`、旋转文字、分组、`<use>`、HTML 标签均通过 CTM 换算到根坐标系 |
| 健壮性 | XML 语法错误给出行列号；格式不符、空文件、超大文件、无法确定画布尺寸均有明确提示 |

---

## 目录结构

```
svg-text-viewer/
├── index.html                  # 页面骨架
├── css/
│   └── app.css                 # 全部样式（深色工具外壳 + 浅色画布）
├── js/
│   ├── svg-parser.js           # 解析 / 清洗 / 样式作用域 / 画布尺寸
│   ├── text-model.js           # 文本索引 / 拼接 / 命中 / 高亮
│   ├── viewport.js             # 平移缩放视口
│   └── app.js                  # UI 装配与文件入口
├── asset/
│   ├── DataFlow.svg            # draw.io HTML 标签示例（32 个 foreignObject）
│   └── InfrastructureDataFlow.svg
├── samples/
│   ├── SingaPort_EFD.svg       # 示例原文件，可直接用于上传测试
│   └── singaport-sample.js     # 同一文件的内嵌版本，供「载入示例」离线使用
└── README.md
```

---

## 实现思路

### 1. 解析、容错与安全

- 用 `DOMParser` 以 `image/svg+xml` 解析，检查根元素必须为 `<svg>`。
- 对常见的「缺少 `xmlns`」导出做一次补全后重试；否则这类文件即使解析成功，节点也不在 SVG 命名空间里、无法渲染。
- 从 `parsererror` 文本中提取行号、列号与原因，直接展示给用户。
- 载入前移除 `<script>`、`<iframe>`、`<object>`、`<embed>` 等可执行内容，清除所有 `on*` 事件属性、`javascript:` 链接、`autofocus` / `autoplay`。
- **HTML 标签安全**：保留 `<foreignObject>` 以显示 draw.io 的 HTML 标签，但移除其内部的 `<style>` 和脚本；通过 CSS 关闭 HTML 内容的指针事件，链接、表单、输入框不会被误触。
- **样式隔离**：SVG 内部的 `<style>` 会被重写为 `#svgHost ...` 作用域，既避免 SVG 的 `.brand` 等规则污染应用 UI，也避免页面样式影响图纸。`html / body` 规则在 SVG 文档中不存在，直接丢弃（否则 `body { background: ... }` 会刷满整张画布）；`@media` 递归处理，`@import` 直接丢弃。
- **配色锁定**：draw.io 新版本会输出 `light-dark()` 双主题。应用外壳是深色，若跟随系统，图纸会变成深底黑字。载入时把根 SVG 的 `color-scheme` 固定为 `light`，保证浅色画布下的可读性。

### 2. 视图：改写 viewBox 而不是缩放 DOM

视口维护一个用户坐标系窗口 `{x, y, w, h}`，每次变化写回根 `<svg viewBox="...">`：

- 缩放 = 缩小/扩大窗口；浏览器按当前视口重新渲染矢量，**放大 1000% 依然清晰**。
- 跟随光标缩放：把屏幕坐标换算为用户坐标作为锚点，缩放后保持该点不动。
- 窗口宽高比始终等于画布容器宽高比，因此 `preserveAspectRatio` 不会产生留白或拉伸，屏幕坐标 ↔ 用户坐标是一一线性映射。
- 拖拽平移按 `dx * (view.w / 容器宽)` 换算；保留至少半个视口的内容，防止把图纸完全拖丢。
- `ResizeObserver` 在容器尺寸变化时保持缩放比与中心点；未手动缩放时重新适应窗口。
- 高亮层是另一个同尺寸 SVG，与主图共用同一个 `viewBox`，天然对齐。

### 3. 文本索引与拼接

#### 3.1 标准 `<text>`

建立索引时对每个 `<text>`：

- 跳过 `<defs> / <symbol> / <clipPath> / <mask>` 等不直接绘制的容器；
- 用 `checkVisibility`（旧浏览器回退 `getClientRects`）+ 计算样式排除 `display:none`、`visibility:hidden`、`opacity:0`、`fill:none && stroke:none`；
- 递归读取所有文本节点，按 `tspan` 的 `y / dy` 判断换行：
  - 与上一段基线相差超过半个字高 → 新行；
  - `dy` 超过 0.6 个字高 → 新行；
  - 同一行内带 `x` 的逐词 `tspan` 自动补空格；
- 对 draw.io 这类「一个多行标签拆成多个同级 `<text>`」的导出，做保守合并：同父节点、同 `x`、行距 0.9–1.9 em、水平投影有交集，才拼成一个标签（本示例中 109 个 `<text>` 合并为 98 个可点击标签）。

#### 3.2 `<foreignObject>` HTML 标签

draw.io 勾选「HTML 标签」后导出的 SVG 中**没有任何 `<text>`**，文字全部位于 `<foreignObject>` 的 XHTML `<div>` 里。这类文件单独处理：

- 遍历 `<foreignObject>`，跳过隐藏、空文本、位于 `defs / symbol` 中的节点；
- **定位文字容器**：从第一个子元素开始，只要「只有一个子元素、且子元素包含全部文字」就继续向下，找到最内层容器。原因是 draw.io 的 `foreignObject` 往往铺满整张画布，外层 `div` 还带 `padding-top`，只有最内层 `inline-block` 的矩形才是文字的真实范围；
- **读取文本**：用 `innerText` 获取可见文本，`<br>` 与块级换行会变成 `\n`；按行压缩空格，保留最多一个空行作为段落分隔；
- **计算几何**：HTML 元素没有 `getBBox()`，先取文字容器的 `getBoundingClientRect()`，再用 `foreignObject.getScreenCTM()` 的逆矩阵映射回其局部坐标系，之后与 `<text>` 共用同一套「局部矩形 × localToRootMatrix」流程；
- 实测 `DataFlow.svg` 的 32 个 `foreignObject` 索引出 31 个非空标签，`InfrastructureDataFlow.svg` 的 19 个全部命中。

### 4. 命中检测

- 每个 `<text>` 用 `getBBox()` 取本地包围盒；HTML 标签用「文字容器屏幕矩形 + 逆 screenCTM」得到局部矩形。两者都再用 `反(root.getCTM()) × 元素.getCTM()` 映射到根用户坐标系，缓存 AABB。
- 点击时把鼠标 `clientX/Y` 换算成用户坐标，在 AABB 内做命中（约 3px 屏幕容差），多个重叠时取面积最小者。
- 若包围盒未命中（字形边缘、`textPath` 等），回退到事件目标向上查找最近的 `<text> / <use> / <foreignObject>`。
- 拖动超过 4px 的 click 会被识别为平移，不会误改选中内容。
- 旋转、缩放、translate 嵌套的文字，包围盒与高亮矩阵都包含对应变换；自动化测试中旋转文字的高亮框与文字屏幕矩形中心误差 < 0.001px。

### 5. 复用文字与 `<use>`

`<use>` 本身在渲染树中，但被引用的 `<text>` 位于 `<defs>` 中、不在直接文本索引里。因此单独遍历 `<use>`：

- 解析 `href / xlink:href` 找到目标（支持引用 `<text>` 或包含文字的 `<g>/<symbol>`）；
- 用 `<use>` 的包围盒作为高亮范围，文本取自被引用内容；
- 支持最多 4 层 `use → use` 嵌套。

### 6. 高亮

在独立覆盖 SVG 中绘制 `<rect>`，设置：

- `transform="matrix(...)"` 复用文字的本地 → 根坐标变换，旋转文字与 HTML 标签也能贴合；
- `vector-effect="non-scaling-stroke"` 保证虚线边框在任何缩放下都是 1.4px；
- 不添加用户单位的 padding，避免深度放大时 padding 被同步放大；
- HTML 标签的高亮框直接来自文字容器，实测 605% 缩放时与文字屏幕矩形完全重合；
- `foreignObject` 内容统一设为 `pointer-events: none`，点击由坐标命中接管，不会误触 HTML 链接/表单。

### 7. 文本标签的换行处理

- 「连接换行」默认关闭，文本按原始换行显示；
- 勾选后去掉换行符，并显示从属选项「替换为空格」；
- 再勾选「替换为空格」时，把换行替换为空格（连续换行按一个分隔处理，避免出现连续空格）；
- 文本区、`字符 / 行` 统计与「复制」内容都使用同一份处理结果；
- 切换不同文字时选项保持；关闭「连接换行」会复位并隐藏「替换为空格」；载入新文档时恢复默认；
- 切换选项只更新面板内容，不重播选中动画，也不影响左侧高亮。

实现集中在 `js/app.js` 的 `formatText()` 与两个 `change` 事件处理函数中。

---

## 已知边界

- **文字已转曲（path）** 的 SVG 无法提取文本，这是矢量格式本身的限制。
- **HTML 标签是只读的**：`foreignObject` 内部的 `<style>`、脚本会被移除，链接/表单/滚动等交互被禁用；仅依赖内联样式的 draw.io 标签不受影响，但依赖内部样式表的复杂 HTML 标签可能丢失部分外观。
- 旋转的 HTML 标签，高亮使用轴对齐包围盒（AABB）近似；未旋转的标签精确贴合文字矩形。
- 同级多行 `<text>` 的合并是启发式规则；如遇到误合并，可在 `text-model.js` 的 `canMergeAsLine()` 中收紧行距/对齐条件，或直接返回 `false` 关闭。
- 文本中的连续空格会被归一化（`xml:space="preserve"` 也未保留原始缩进），更符合「阅读标签」而非「逐字还原」的场景。
- 外部 `@import` 会被丢弃；SVG 内 `<image>` 引用的远程图片、`@font-face` 字体仍可能发起网络请求。
- 根 SVG 的 `color-scheme` 被固定为 `light`（避免深色外壳下出现深底黑字）；仅提供深色主题的 SVG 可能出现配色偏差。
- 单文件上限 25 MB；超大图纸的文本索引与命中为 O(n)，常规工程图（数千文本）无压力。

---

## 验证情况

使用无头 Chrome（Puppeteer）做了自动化回归，覆盖：

- 示例图：109 个 `<text>` 正确索引为 98 个标签，多行标签拼接为 `CTN Being\nUnstacked`；
- 业务图：`DataFlow.svg` 的 32 个 `foreignObject` 索引出 31 个非空标签；`InfrastructureDataFlow.svg` 的 19 个全部索引；
- HTML 标签：`Input Data`、`Data Bus`、`Pre-processing\n&\nTransformation`、长描述多行文本均正确；605% 缩放下高亮与文字屏幕矩形完全重合；
- 换行选项：3 行文本连接后变为 1 行，勾选「替换为空格」后得到 `Pre-processing & Transformation`，复制内容与统计同步，取消勾选恢复原始换行；
- 100% / 169% / 1336% 缩放下，点击命中、文字屏幕矩形与高亮框中心对齐；
- 拖拽平移、滚轮光标锚点、缩放上下限（6%–3200%）、适应窗口；
- 1440×900 与 900×780 窗口重排后 viewBox 宽高比一致、点击仍准确；
- `translate`、`scale`、`rotate`、`<use>`、嵌套 `tspan`、中文、隐藏文字、`defs` 文字；
- XML 语法错误、非 SVG 文件、缺失 `xmlns`、无文字 SVG、无 `viewBox`、百分比尺寸；
- SVG 内 `<script>`/`onclick` 不执行、`foreignObject` 内 `<style>`/`<script>` 被移除、`body` 背景规则被丢弃、页面无滚动条溢出；
- 拖拽上传、快捷键（`+` `-` `0` `Esc` `Ctrl+O`）、复制反馈。

---

## 可调整项

| 需求 | 位置 |
| --- | --- |
| 缩放上下限 | `js/viewport.js` 顶部 `MIN_RATIO / MAX_RATIO` |
| 适应窗口留白 | `js/app.js` 创建 Viewport 时的 `padding` |
| 点击容差 | `js/app.js` 中 `3 / scale` 的 `3` |
| 多行合并规则 | `js/text-model.js` 的 `canMergeAsLine()` |
| 文件大小上限 | `js/svg-parser.js` 的 `MAX_FILE_BYTES` |
| 配色 / 面板宽度 | `css/app.css` 顶部变量与 `.inspector` |
