/*!
 * app.js — 应用装配：文件上传 / 拖拽、视图控制、文字选择与面板渲染
 */
(function () {
  'use strict';

  const SvgDoc = window.SvgDoc;
  const TextModel = window.TextModel;
  const Viewport = window.Viewport;

  const els = {
    stage: document.getElementById('stage'),
    svgHost: document.getElementById('svgHost'),
    selectionLayer: document.getElementById('selectionLayer'),
    fileInput: document.getElementById('fileInput'),
    openBtn: document.getElementById('openBtn'),
    sampleBtn: document.getElementById('sampleBtn'),
    emptyOpenBtn: document.getElementById('emptyOpenBtn'),
    emptySampleBtn: document.getElementById('emptySampleBtn'),
    emptyState: document.getElementById('emptyState'),
    zoomBar: document.getElementById('zoomBar'),
    zoomLabel: document.getElementById('zoomLabel'),
    zoomValueBtn: document.getElementById('zoomValueBtn'),
    zoomInBtn: document.getElementById('zoomInBtn'),
    zoomOutBtn: document.getElementById('zoomOutBtn'),
    fitBtn: document.getElementById('fitBtn'),
    canvasHint: document.getElementById('canvasHint'),
    docChip: document.getElementById('docChip'),
    docName: document.getElementById('docName'),
    docMeta: document.getElementById('docMeta'),

    inspectorEmpty: document.getElementById('inspectorEmpty'),
    selectionCard: document.getElementById('selectionCard'),
    selectionTag: document.getElementById('selectionTag'),
    selectionStats: document.getElementById('selectionStats'),
    selectionText: document.getElementById('selectionText'),
    selectionOrigin: document.getElementById('selectionOrigin'),
    joinLinesToggle: document.getElementById('joinLinesToggle'),
    spaceToggleWrap: document.getElementById('spaceToggleWrap'),
    spaceToggle: document.getElementById('spaceToggle'),
    copyBtn: document.getElementById('copyBtn'),
    copyLabel: document.getElementById('copyLabel'),

    errorOverlay: document.getElementById('errorOverlay'),
    errorTitle: document.getElementById('errorTitle'),
    errorMessage: document.getElementById('errorMessage'),
    errorDetail: document.getElementById('errorDetail'),
    errorRetryBtn: document.getElementById('errorRetryBtn'),
    errorCloseBtn: document.getElementById('errorCloseBtn'),

    dropOverlay: document.getElementById('dropOverlay'),
    busyOverlay: document.getElementById('busyOverlay'),
    busyText: document.getElementById('busyText'),
    toastStack: document.getElementById('toastStack')
  };

  const state = {
    doc: null,
    fileName: '',
    entries: [],
    selected: null,
    viewport: null,
    highlighter: null,
    loadToken: 0,
    copying: false,
    // 文本标签的换行处理选项（作用于显示、统计与复制）
    joinLines: false,
    replaceWithSpace: false
  };

  /* ======================================================================
   * 通用工具
   * ==================================================================== */

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    });
  }

  function waitForFonts(timeout) {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return Promise.race([
      document.fonts.ready,
      new Promise(function (resolve) { setTimeout(resolve, timeout || 800); })
    ]);
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () {
        reject(new SvgDoc.SvgParseError('文件读取失败', '浏览器无法读取该文件，请检查文件是否被占用或权限是否足够。'));
      };
      reader.readAsText(file, 'utf-8');
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ======================================================================
   * 加载 SVG
   * ==================================================================== */

  async function loadFromText(text, fileName) {
    const token = (state.loadToken += 1);

    hideError();
    setBusy(true, '正在解析 SVG…');
    await nextFrame();

    let svg = null;
    let baseBox = null;

    try {
      svg = SvgDoc.parseSvgText(text);
      SvgDoc.sanitize(svg);
      SvgDoc.scopeStyles(svg, '#' + els.svgHost.id);
      baseBox = measureBaseBox(svg);

      if (!baseBox) {
        throw new SvgDoc.SvgParseError(
          '无法确定画布尺寸',
          '该 SVG 缺少有效的 viewBox，也没有可用的 width / height 或可见图形，无法确定显示范围。'
        );
      }
    } catch (err) {
      if (token === state.loadToken) {
        setBusy(false);
        showError(err);
      }
      return;
    }

    if (token !== state.loadToken) return;

    // ---- 提交：替换画布内容 ----
    detachCurrentDoc();

    els.svgHost.replaceChildren(svg);
    SvgDoc.attach(svg);
    els.selectionLayer.replaceChildren();

    state.doc = svg;
    state.fileName = fileName;
    resetPanel();

    els.emptyState.hidden = true;
    els.zoomBar.hidden = false;
    els.canvasHint.hidden = false;
    els.docChip.hidden = false;
    updateDocChip(fileName, baseBox, 0);

    state.viewport = Viewport.create({
      stage: els.stage,
      targets: [svg, els.selectionLayer],
      baseBox: baseBox,
      padding: 28,
      onChange: handleViewChange
    });
    state.viewport.fit();

    setBusy(false);

    // 字体替换会影响文字的实际包围盒，等字体就绪后再建立索引，
    // 否则命中区域可能与视觉位置产生偏差。
    await waitForFonts(900);
    if (token !== state.loadToken || state.doc !== svg) return;

    try {
      state.entries = TextModel.buildTextIndex(svg);
      state.highlighter = TextModel.createHighlighter(els.selectionLayer);
      updateDocChip(fileName, baseBox, state.entries.length);

      if (state.entries.length) {
        toast('已载入 ' + state.entries.length + ' 处文本', 'success', 2400);
      } else {
        toast('未发现可提取的文本元素', 'warn', 3200);
      }
    } catch (err) {
      console.error('[SVG Viewer] 文本索引构建失败：', err);
      toast('文本索引构建失败，图形仍可正常查看', 'error', 3600);
    }
  }

  /**
   * 在离屏容器中挂载并测量基础画布范围。
   * 这样即使测量失败，也不会破坏当前已打开的图纸。
   */
  function measureBaseBox(svg) {
    const sandbox = document.createElement('div');
    sandbox.style.cssText = 'position:absolute;left:-100000px;top:0;width:1100px;height:760px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(sandbox);

    try {
      SvgDoc.attach(svg);
      sandbox.appendChild(svg);
      return SvgDoc.resolveBaseBox(svg);
    } finally {
      sandbox.remove();
      SvgDoc.attach(svg);
    }
  }

  function detachCurrentDoc() {
    if (state.viewport) {
      state.viewport.destroy();
      state.viewport = null;
    }
    if (state.highlighter) {
      state.highlighter.clear();
      state.highlighter = null;
    }
    state.doc = null;
    state.entries = [];
    state.selected = null;
  }

  function updateDocChip(name, box, count) {
    const size = Math.round(box.w) + ' × ' + Math.round(box.h);
    const text = count ? size + ' · ' + count + ' 段文本' : size;
    els.docName.textContent = name;
    els.docMeta.textContent = text;
    els.docChip.title = name + ' · ' + text;
  }

  /* ======================================================================
   * 文件入口
   * ==================================================================== */

  async function handleFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    if (files.length > 1) {
      toast('一次仅支持载入一个 SVG，已使用第一个文件', 'info', 2600);
    }

    const file = files[0];

    if (!/\.svg$/i.test(file.name)) {
      showError(new SvgDoc.SvgParseError(
        '文件格式不受支持',
        '仅接受 .svg 文件，当前选择的是“' + file.name + '”。'
      ));
      return;
    }

    if (file.size === 0) {
      showError(new SvgDoc.SvgParseError('文件内容为空', '“' + file.name + '”大小为 0 字节。'));
      return;
    }

    if (file.size > SvgDoc.MAX_FILE_BYTES) {
      showError(new SvgDoc.SvgParseError(
        '文件过大',
        '文件大小 ' + formatBytes(file.size) + '，超过 ' + formatBytes(SvgDoc.MAX_FILE_BYTES) + ' 的上限。'
      ));
      return;
    }

    try {
      const text = await readFileAsText(file);
      await loadFromText(text, file.name);
    } catch (err) {
      showError(err);
    }
  }

  function loadSample() {
    const sample = window.EFD_SAMPLE;
    if (!sample || !sample.content) {
      showError(new SvgDoc.SvgParseError('示例不可用', '未找到内置示例数据，请直接上传 SVG 文件。'));
      return;
    }
    loadFromText(sample.content, sample.name || 'sample.svg');
  }

  /* ======================================================================
   * 选择与面板
   * ==================================================================== */

  function handleCanvasClick(event) {
    if (!state.doc || !state.viewport) return;

    // 拖动结束后的 click 不是“选择”动作
    if (state.viewport.consumeClickSuppression()) return;

    // 阻止 SVG 内部 <a> 链接跳转
    if (event.target && event.target.closest && event.target.closest('a')) {
      event.preventDefault();
    }

    const point = state.viewport.clientToUser(event.clientX, event.clientY);
    // 屏幕 3px 容差，按当前缩放换算成用户单位
    const tolerance = 3 / Math.max(state.viewport.getScale(), 1e-6);

    let entry = TextModel.hitTest(state.entries, point, tolerance);
    if (!entry) entry = TextModel.findEntryForElement(state.entries, event.target);

    if (entry) selectEntry(entry);
    else clearSelection();
  }

  /**
   * 按面板选项处理换行：
   * - 未勾选「连接换行」：原样保留；
   * - 勾选：去掉换行；
   * - 同时勾选「替换为空格」：把换行改为空格。
   * 连续换行（段落空行）按一个分隔处理，避免出现连续多个空格。
   */
  function formatText(text) {
    if (!state.joinLines) return text;
    return state.replaceWithSpace
      ? text.replace(/\n+/g, ' ')
      : text.replace(/\n+/g, '');
  }

  function selectEntry(entry) {
    if (!entry || entry === state.selected) return;

    state.selected = entry;
    if (state.highlighter) state.highlighter.show(entry);
    renderPanel(entry);
  }

  function clearSelection() {
    state.selected = null;
    if (state.highlighter) state.highlighter.clear();

    els.selectionCard.hidden = true;
    els.inspectorEmpty.hidden = false;
    els.copyBtn.disabled = true;
    els.copyBtn.classList.remove('is-done');
    els.copyLabel.textContent = '复制';

    els.selectionText.textContent = '';
    els.selectionStats.textContent = '';
    els.selectionOrigin.textContent = '';
  }

  function resetPanel() {
    state.selected = null;
    if (state.highlighter) state.highlighter.clear();

    els.selectionCard.hidden = true;
    els.inspectorEmpty.hidden = false;
    els.copyBtn.disabled = true;
    els.copyBtn.classList.remove('is-done');
    els.copyLabel.textContent = '复制';

    // 新文档恢复默认：保留原始换行
    state.joinLines = false;
    state.replaceWithSpace = false;
    els.joinLinesToggle.checked = false;
    els.spaceToggle.checked = false;
    els.spaceToggleWrap.hidden = true;
  }

  function renderPanel(entry, options) {
    const animate = !options || options.animate !== false;
    const text = formatText(entry.text);
    const chars = text.replace(/\n/g, '').length;
    const lines = text.split('\n').length;

    els.inspectorEmpty.hidden = true;
    els.selectionCard.hidden = false;
    els.copyBtn.disabled = false;
    els.copyBtn.classList.remove('is-done');
    els.copyLabel.textContent = '复制';

    els.selectionTag.textContent = entry.kind === 'use'
      ? '<use>'
      : (entry.kind === 'foreign' ? '<foreignObject>' : '<text>');
    els.selectionStats.textContent = chars + ' 字符 · ' + lines + ' 行';
    els.selectionText.textContent = text;
    els.selectionOrigin.textContent = describeOrigin(entry);

    // 重新触发入场动画，让连续点击也有明确反馈；切换选项时不重播
    if (animate) {
      els.selectionCard.style.animation = 'none';
      void els.selectionCard.offsetWidth;
      els.selectionCard.style.animation = '';
    }
  }

  function handleJoinLinesChange() {
    state.joinLines = els.joinLinesToggle.checked;

    if (state.joinLines) {
      els.spaceToggleWrap.hidden = false;
    } else {
      // 关闭“连接换行”时，从属选项一并复位
      state.replaceWithSpace = false;
      els.spaceToggle.checked = false;
      els.spaceToggleWrap.hidden = true;
    }

    if (state.selected) renderPanel(state.selected, { animate: false });
  }

  function handleReplaceWithSpaceChange() {
    state.replaceWithSpace = els.spaceToggle.checked;
    if (state.selected) renderPanel(state.selected, { animate: false });
  }

  function describeOrigin(entry) {
    const el = entry.el;
    let label = '<' + el.localName + '>';

    if (entry.kind === 'use') {
      label += ' → #' + (entry.targetId || '?');
    } else if (el.id) {
      label += ' #' + el.id;
    }

    const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (classes.length) label += ' .' + classes[0];

    if (entry.parts.length > 1) label += ' · ' + entry.parts.length + ' 行合并';

    return '来源元素 ' + label;
  }

  function copySelection() {
    if (!state.selected || state.copying) return;

    // 复制与面板当前显示保持一致（含换行处理）
    const text = formatText(state.selected.text);
    state.copying = true;

    const done = function () {
      state.copying = false;
      els.copyBtn.classList.add('is-done');
      els.copyLabel.textContent = '已复制';
      toast('文本已复制到剪贴板', 'success', 1800);
      setTimeout(function () {
        els.copyBtn.classList.remove('is-done');
        els.copyLabel.textContent = '复制';
      }, 1600);
    };

    const fail = function () {
      state.copying = false;
      toast('复制失败，请手动选中文本复制', 'error', 2600);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        if (fallbackCopy(text)) done(); else fail();
      });
    } else {
      if (fallbackCopy(text)) done(); else fail();
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    textarea.remove();
    return ok;
  }

  /* ======================================================================
   * 视图控制
   * ==================================================================== */

  function handleViewChange(payload) {
    const percent = Math.round((payload.ratio || 1) * 100);
    els.zoomLabel.textContent = percent + '%';

    // 点阵网格随视图移动，形成“画布跟随”的直观反馈
    const scale = payload.scale || 1;
    els.stage.style.setProperty('--grid-x', ((-payload.x * scale) % 24) + 'px');
    els.stage.style.setProperty('--grid-y', ((-payload.y * scale) % 24) + 'px');
  }

  function zoomAtCenter(factor) {
    if (!state.viewport) return;
    const rect = els.stage.getBoundingClientRect();
    state.viewport.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function fitView() {
    if (!state.viewport) return;
    state.viewport.fit();
    toast('已适应窗口', 'info', 1400);
  }

  /* ======================================================================
   * 错误 / 状态提示
   * ==================================================================== */

  function showError(err) {
    const isParse = err && err.name === 'SvgParseError';
    const detail = err && err.detail ? String(err.detail) : '';

    els.errorTitle.textContent = isParse ? '无法载入该文件' : '操作失败';
    els.errorMessage.textContent = (err && err.message) || '发生未知错误，请重试。';
    els.errorDetail.textContent = detail;
    els.errorDetail.hidden = !detail;
    els.errorOverlay.hidden = false;

    // 焦点移入弹层，方便键盘用户直接操作
    setTimeout(function () { els.errorRetryBtn.focus(); }, 30);
  }

  function hideError() {
    els.errorOverlay.hidden = true;
    els.errorDetail.hidden = true;
    els.errorDetail.textContent = '';
  }

  function setBusy(busy, message) {
    els.busyOverlay.hidden = !busy;
    if (message) els.busyText.textContent = message;
  }

  function toast(message, type, duration) {
    const item = document.createElement('div');
    item.className = 'toast toast--' + (type || 'info');
    item.textContent = message;
    els.toastStack.appendChild(item);

    // 最多同时显示三条
    while (els.toastStack.children.length > 3) {
      els.toastStack.removeChild(els.toastStack.firstChild);
    }

    setTimeout(function () {
      item.classList.add('is-leaving');
      setTimeout(function () { item.remove(); }, 220);
    }, duration || 2400);
  }

  /* ======================================================================
   * 事件绑定
   * ==================================================================== */

  function openFilePicker() {
    els.fileInput.click();
  }

  function bindEvents() {
    els.openBtn.addEventListener('click', openFilePicker);
    els.emptyOpenBtn.addEventListener('click', openFilePicker);
    els.errorRetryBtn.addEventListener('click', openFilePicker);
    els.sampleBtn.addEventListener('click', loadSample);
    els.emptySampleBtn.addEventListener('click', loadSample);
    els.copyBtn.addEventListener('click', copySelection);
    els.joinLinesToggle.addEventListener('change', handleJoinLinesChange);
    els.spaceToggle.addEventListener('change', handleReplaceWithSpaceChange);
    els.errorCloseBtn.addEventListener('click', hideError);

    els.fileInput.addEventListener('change', function () {
      const files = els.fileInput.files;
      if (files && files.length) handleFiles(files);
      els.fileInput.value = '';
    });

    els.stage.addEventListener('click', handleCanvasClick);

    els.zoomInBtn.addEventListener('click', function () { zoomAtCenter(1.3); });
    els.zoomOutBtn.addEventListener('click', function () { zoomAtCenter(1 / 1.3); });
    els.zoomValueBtn.addEventListener('click', fitView);
    els.fitBtn.addEventListener('click', fitView);

    bindDropZone();
    bindKeyboard();
  }

  function bindDropZone() {
    let depth = 0;
    let hideTimer = null;

    function hasFiles(event) {
      const dt = event.dataTransfer;
      if (!dt) return false;
      if (dt.types) {
        return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
      }
      return dt.files && dt.files.length > 0;
    }

    function show() {
      els.dropOverlay.hidden = false;
    }

    function hide() {
      depth = 0;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      els.dropOverlay.hidden = true;
    }

    // 拖拽期间 dragover 会持续触发；一旦停止（拖出窗口、切走等）自动收起遮罩，
    // 避免 dragenter / dragleave 计数不平衡导致遮罩残留。
    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { hide(); }, 900);
    }

    window.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      show();
      scheduleHide();
    });

    window.addEventListener('dragover', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      show();
      scheduleHide();
    });

    window.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) els.dropOverlay.hidden = true;
    });

    window.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      hide();
      handleFiles(event.dataTransfer.files);
    });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (event) {
      const target = event.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || (target && target.isContentEditable)) return;

      if ((event.ctrlKey || event.metaKey) && (event.key === 'o' || event.key === 'O')) {
        event.preventDefault();
        openFilePicker();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) return;

      switch (event.key) {
        case '+':
        case '=':
          if (state.viewport) { event.preventDefault(); zoomAtCenter(1.3); }
          break;
        case '-':
        case '_':
          if (state.viewport) { event.preventDefault(); zoomAtCenter(1 / 1.3); }
          break;
        case '0':
          if (state.viewport) { event.preventDefault(); state.viewport.fit(); }
          break;
        case 'Escape':
          if (!els.errorOverlay.hidden) hideError();
          else clearSelection();
          break;
        default:
          break;
      }
    });
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */

  function init() {
    els.selectionLayer.setAttribute('viewBox', '0 0 100 100');
    els.selectionCard.style.display = '';
    bindEvents();
  }

  init();
})();
