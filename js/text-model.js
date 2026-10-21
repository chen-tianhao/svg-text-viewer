/*!
 * text-model.js — 文本索引、文本拼接、命中检测与高亮绘制
 *
 * 关键点：
 * 1. 文本坐标统一换算到「根 SVG 用户坐标系」，与视口改写 viewBox 的方式解耦，
 *    因此缩放/平移后命中位置与视觉位置始终一致。
 * 2. 支持 <text> 内部的多行 tspan、<a> 包裹、<textPath>、<use> 复用，
 *    以及 draw.io HTML 标签使用的 <foreignObject>。
 * 3. 高亮画在独立的覆盖层 SVG 上，不修改原文档结构。
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const MAX_USE_DEPTH = 4;

  /* ======================================================================
   * 文本索引
   * ==================================================================== */

  function buildTextIndex(root) {
    const entries = [];

    // 1) 普通 <text>：跳过 defs / symbol / clipPath 等不直接绘制的容器
    const textEls = root.querySelectorAll('text');
    Array.prototype.forEach.call(textEls, function (el) {
      if (!isDirectlyRendered(el, root)) return;
      if (!isVisible(el, true)) return;

      const bbox = getLocalBBox(el);
      if (!bbox) return;

      const text = extractText(el).trim();
      if (!text) return;

      entries.push(createEntry(el, [{
        el: el,
        bbox: bbox,
        matrix: localToRootMatrix(el, root)
      }], text, 'text'));
    });

    // 2) <foreignObject> 内的 HTML 标签（draw.io 的 html=1 导出）
    //    这类文件完全没有 <text>，文字在 XHTML 的 div/span/font 中。
    const foreignObjects = root.querySelectorAll('foreignObject');
    Array.prototype.forEach.call(foreignObjects, function (fo) {
      if (!isDirectlyRendered(fo, root)) return;
      if (!isVisible(fo, false)) return;

      const label = findForeignLabelElement(fo);
      if (!label) return;

      const text = extractForeignText(label);
      if (!text) return;

      // HTML 元素没有 getBBox，用屏幕矩形 + foreignObject 的逆 CTM
      // 换算回它自己的局部坐标系，再走与 <text> 相同的矩阵链路。
      const rect = label.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;

      const screenCTM = fo.getScreenCTM();
      if (!screenCTM) return;

      const bbox = screenRectToLocalBox(rect, screenCTM);
      if (!bbox) return;

      // 同一 foreignObject 在 draw.io 中可能铺满整张画布，
      // 因此命中框取“文字容器”的紧致矩形，而不是 foreignObject 本身。
      entries.push(createEntry(fo, [{
        el: fo,
        bbox: bbox,
        matrix: localToRootMatrix(fo, root)
      }], text, 'foreign'));
    });

    // 3) <use> 复用：被引用内容在 defs/symbol 中，自身不在上一步的索引里
    const useEls = root.querySelectorAll('use');
    Array.prototype.forEach.call(useEls, function (use) {
      if (!isDirectlyRendered(use, root)) return;
      if (!isVisible(use, false)) return;

      const target = resolveUseTarget(use, root);
      if (!target) return;

      const textElsInUse = collectTextElements(target);
      if (!textElsInUse.length) return;

      const texts = textElsInUse.map(function (el) {
        return extractText(el).trim();
      }).filter(Boolean);
      if (!texts.length) return;

      const bbox = getLocalBBox(use);
      if (!bbox) return;

      entries.push(createEntry(use, [{
        el: use,
        bbox: bbox,
        matrix: localToRootMatrix(use, root)
      }], texts.join('\n'), 'use', target.id || ''));
    });

    // 4) 合并同一父节点下“同 x、行距正常”的相邻 <text>（多行标签的常见导出形式）
    return mergeSiblingLines(entries);
  }

  /** 判断元素是否位于不直接绘制的容器内 */
  function isDirectlyRendered(el, root) {
    let node = el.parentNode;
    while (node && node !== root) {
      if (node.nodeType === 1) {
        const name = node.localName.toLowerCase();
        if (global.SvgDoc && global.SvgDoc.HIDDEN_CONTAINERS.has(name)) return false;
      }
      node = node.parentNode;
    }
    return true;
  }

  /**
   * 可见性判断：
   * - checkPaint=false 时只判断 display/visibility/opacity（用于 <use>，
   *   其 fill 计算值不代表被引用文字的真实填充色）
   */
  function isVisible(el, checkPaint) {
    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;

    if (checkPaint) {
      const fill = style.fill;
      const stroke = style.stroke;
      const strokeWidth = parseFloat(style.strokeWidth || '0');
      // fill 与 stroke 都不可见时，文字不会出现在画面上
      if (fill === 'none' && (stroke === 'none' || !(strokeWidth > 0))) return false;
    }

    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (err) {
        /* 旧实现不支持参数时回退 */
      }
    }
    return el.getClientRects().length > 0;
  }

  function getLocalBBox(el) {
    try {
      const box = el.getBBox();
      if (!box || !(box.width > 0) || !(box.height > 0)) return null;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    } catch (err) {
      return null;
    }
  }

  /**
   * 元素本地坐标 → 根 SVG 用户坐标。
   * 两个 CTM 都包含“viewBox → 视口”的映射，相除后互相抵消，
   * 因此得到的矩阵不受当前缩放/平移影响，可长期缓存。
   */
  function localToRootMatrix(el, root) {
    const elCTM = el.getCTM();
    const rootCTM = root.getCTM();
    if (!elCTM || !rootCTM) return new DOMMatrix();
    try {
      return rootCTM.inverse().multiply(elCTM);
    } catch (err) {
      return new DOMMatrix();
    }
  }

  function transformBoxToAabb(box, matrix) {
    // 手动套用仿射矩阵：部分浏览器的 getCTM() 返回旧版 SVGMatrix，
    // 并不支持 DOMMatrix 的 transformPoint()。
    function apply(x, y) {
      return {
        x: matrix.a * x + matrix.c * y + matrix.e,
        y: matrix.b * x + matrix.d * y + matrix.f
      };
    }

    const corners = [
      apply(box.x, box.y),
      apply(box.x + box.width, box.y),
      apply(box.x, box.y + box.height),
      apply(box.x + box.width, box.y + box.height)
    ];
    const xs = corners.map(function (p) { return p.x; });
    const ys = corners.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs);
    const maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys);
    const maxY = Math.max.apply(null, ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function createEntry(el, parts, text, kind, targetId) {
    let aabb = null;
    parts.forEach(function (part) {
      const box = transformBoxToAabb(part.bbox, part.matrix);
      aabb = aabb ? unionAabb(aabb, box) : box;
    });

    const fontSize = parseFloat(getComputedStyle(el).fontSize) || 16;

    return {
      el: el,
      parts: parts,
      text: text,
      kind: kind,
      targetId: targetId || '',
      aabb: aabb,
      area: Math.max(aabb.w, 1) * Math.max(aabb.h, 1),
      fontSize: fontSize,
      lineCount: text.split('\n').length,
      id: el.id || '',
      className: el.getAttribute('class') || ''
    };
  }

  function unionAabb(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.w, b.x + b.w);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return { x: x, y: y, w: right - x, h: bottom - y };
  }

  function resolveUseTarget(use, root) {
    let href = use.getAttribute('href') || use.getAttributeNS(XLINK_NS, 'href');
    if (!href) return null;
    href = href.trim();
    if (href.charAt(0) !== '#') return null;

    const id = decodeURIComponent(href.slice(1));
    const found = use.ownerDocument.getElementById(id);
    return found && root.contains(found) && found !== root ? found : null;
  }

  /** 递归收集 <use> 引用内容中的 text（兼容 use 引用 use 的嵌套情况） */
  function collectTextElements(node, depth) {
    const level = depth || 0;
    if (!node || level > MAX_USE_DEPTH) return [];

    const name = node.localName.toLowerCase();
    if (name === 'text') return [node];

    if (name === 'use') {
      const target = resolveUseTarget(node, node.ownerSVGElement || node.ownerDocument.documentElement);
      return target ? collectTextElements(target, level + 1) : [];
    }

    const direct = Array.prototype.slice.call(node.querySelectorAll('text'));
    if (direct.length) return dedupe(direct);

    // 引用的分组里可能只有一个 <use>
    const nestedUses = node.querySelectorAll('use');
    let result = [];
    Array.prototype.forEach.call(nestedUses, function (use) {
      result = result.concat(collectTextElements(use, level + 1));
    });
    return dedupe(result);
  }

  function dedupe(list) {
    return list.filter(function (item, index) { return list.indexOf(item) === index; });
  }

  /* ======================================================================
   * foreignObject（HTML 标签）
   * ==================================================================== */

  const FOREIGN_TEXT_CONTAINERS = {
    div: true, p: true, span: true, font: true, b: true, strong: true,
    i: true, em: true, small: true, u: true, center: true,
    section: true, article: true, label: true
  };

  /**
   * 找到 foreignObject 中最深、且仍然包含全部文字的单一容器。
   * draw.io 的结构通常是 foreignObject > div(flex) > div(box) > div(inline-block)，
   * 最内层才有紧致的文字包围盒（外层可能带 padding，甚至铺满整张画布）。
   */
  function findForeignLabelElement(fo) {
    let current = fo.firstElementChild;
    if (!current) return null;

    const fullText = normalizePlain(fo.textContent);
    if (!fullText) return null;

    let guard = 0;
    while (current && current.children.length === 1 && guard < 40) {
      const child = current.firstElementChild;
      if (!child) break;
      // XHTML 元素的 localName 是小写的 div / font / span
      if (!FOREIGN_TEXT_CONTAINERS[child.localName.toLowerCase()]) break;
      if (normalizePlain(child.textContent) !== fullText) break;
      current = child;
      guard += 1;
    }
    return current;
  }

  /** 读取 HTML 标签文本；innerText 会把 <br> 与块级换行转换为 \n */
  function extractForeignText(element) {
    let raw = '';
    try {
      raw = element.innerText || '';
    } catch (err) {
      raw = '';
    }
    if (!raw.trim()) raw = element.textContent || '';
    return normalizeMultiline(raw);
  }

  function normalizePlain(value) {
    return String(value || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 按行清理空格；保留最多一个空行，以保留段落结构 */
  function normalizeMultiline(value) {
    const lines = String(value || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(function (line) {
        return line.replace(/[ \t]+/g, ' ').trim();
      });

    const result = [];
    lines.forEach(function (line) {
      if (!line) {
        if (result.length && result[result.length - 1] !== '') result.push('');
        return;
      }
      result.push(line);
    });

    while (result.length && result[result.length - 1] === '') result.pop();
    return result.join('\n');
  }

  /**
   * 屏幕矩形 → foreignObject 局部坐标。
   * HTML 元素没有 getBBox，只能先取 getBoundingClientRect()，
   * 再用 foreignObject.getScreenCTM() 的逆矩阵映射回去。
   */
  function screenRectToLocalBox(rect, screenCTM) {
    let inverse;
    try {
      inverse = screenCTM.inverse();
    } catch (err) {
      return null;
    }

    function map(x, y) {
      return {
        x: inverse.a * x + inverse.c * y + inverse.e,
        y: inverse.b * x + inverse.d * y + inverse.f
      };
    }

    const corners = [
      map(rect.left, rect.top),
      map(rect.right, rect.top),
      map(rect.left, rect.bottom),
      map(rect.right, rect.bottom)
    ];
    const xs = corners.map(function (p) { return p.x; });
    const ys = corners.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs);
    const maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys);
    const maxY = Math.max.apply(null, ys);

    if (!(maxX - minX > 0.001) || !(maxY - minY > 0.001)) return null;

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /* ======================================================================
   * 文本拼接
   * ==================================================================== */

  /**
   * 提取 <text> 的完整文本：
   * - 递归读取所有文本节点（含 tspan / textPath / a 内嵌）
   * - 依据 tspan 的 y / dy 判断换行，多行内容用 \n 连接
   * - 逐词定位（同一 y 上多个带 x 的 tspan）自动补空格
   */
  function extractText(textEl) {
    const lines = [];
    let buffer = '';
    const fontSize = parseFloat(getComputedStyle(textEl).fontSize) || 16;
    let prevY = toNumber(textEl.getAttribute('y'));

    function hasContent() {
      return buffer.trim().length > 0 || lines.length > 0;
    }

    function flush() {
      const line = normalizeLine(buffer);
      if (line) lines.push(line);
      buffer = '';
    }

    function walk(node) {
      const children = node.childNodes;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];

        if (child.nodeType === 3) {
          buffer += child.nodeValue;
          continue;
        }
        if (child.nodeType !== 1) continue;

        const tag = child.localName.toLowerCase();
        if (tag === 'title' || tag === 'desc' || tag === 'metadata') continue;
        if (tag !== 'tspan' && tag !== 'textpath' && tag !== 'a') continue;

        const yAttr = child.getAttribute('y');
        const dyAttr = child.getAttribute('dy');
        const xAttr = child.getAttribute('x');

        let newLine = false;
        let nextY = prevY;

        if (yAttr != null && yAttr.trim() !== '') {
          const y = toNumber(yAttr);
          if (Number.isFinite(y)) {
            // 与上一段基线差异超过半个字高，视为新的一行；
            // 同一 y 上的多个 tspan（逐词定位）仍属同一行。
            if (Number.isFinite(prevY) && Math.abs(y - prevY) > Math.max(fontSize * 0.5, 1.5)) {
              newLine = true;
            }
            nextY = y;
          }
        } else if (dyAttr != null && dyAttr.trim() !== '') {
          const dy = toNumber(dyAttr);
          if (Number.isFinite(dy)) {
            const isEm = /em\s*$/i.test(dyAttr.trim());
            const shift = isEm ? dy * fontSize : dy;
            if (hasContent() && Math.abs(shift) >= fontSize * 0.6) newLine = true;
            if (Number.isFinite(prevY)) nextY = prevY + shift;
          }
        }

        if (newLine) {
          flush();
        } else if (xAttr != null && buffer.length > 0 && /\S$/.test(buffer) &&
                   /^\S/.test(child.textContent || '')) {
          // 同一行内被显式 x 重新定位，且两侧都没有空格 → 补一个空格
          buffer += ' ';
        }

        walk(child);
        if (Number.isFinite(nextY)) prevY = nextY;
      }
    }

    walk(textEl);
    flush();

    return lines.join('\n');
  }

  function toNumber(value) {
    if (value == null) return NaN;
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : NaN;
  }

  function normalizeLine(value) {
    return String(value)
      .replace(/\u00A0/g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  /* ======================================================================
   * 同级多行 <text> 合并（启发式）
   * ==================================================================== */

  function mergeSiblingLines(entries) {
    const result = [];
    const byParent = new Map();

    entries.forEach(function (entry) {
      if (entry.kind !== 'text') { result.push(entry); return; }
      const parent = entry.el.parentNode;
      if (!parent) { result.push(entry); return; }
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(entry);
    });

    byParent.forEach(function (list) {
      list.sort(compareDocumentOrder);

      let group = null;
      let previous = null;

      list.forEach(function (entry) {
        if (previous && canMergeAsLine(previous, entry)) {
          group.text += '\n' + entry.text;
          group.parts.push.apply(group.parts, entry.parts);
          group.aabb = unionAabb(group.aabb, entry.aabb);
          group.area = Math.max(group.aabb.w, 1) * Math.max(group.aabb.h, 1);
          group.lineCount += 1;
          group.kind = 'text-group';
        } else {
          group = {
            el: entry.el,
            parts: entry.parts.slice(),
            text: entry.text,
            kind: 'text-group',
            targetId: '',
            aabb: { x: entry.aabb.x, y: entry.aabb.y, w: entry.aabb.w, h: entry.aabb.h },
            area: entry.area,
            fontSize: entry.fontSize,
            lineCount: 1,
            id: entry.id,
            className: entry.className
          };
          result.push(group);
        }
        previous = entry;
      });
    });

    result.sort(compareDocumentOrder);
    return result;
  }

  function canMergeAsLine(prev, next) {
    if (prev.el.parentNode !== next.el.parentNode) return false;
    if (Math.abs(prev.fontSize - next.fontSize) > 0.15) return false;

    const anchorA = prev.el.getAttribute('text-anchor') || 'start';
    const anchorB = next.el.getAttribute('text-anchor') || 'start';
    if (anchorA !== anchorB) return false;

    const x1 = toNumber(prev.el.getAttribute('x'));
    const x2 = toNumber(next.el.getAttribute('x'));
    const y1 = toNumber(prev.el.getAttribute('y'));
    const y2 = toNumber(next.el.getAttribute('y'));
    if (![x1, x2, y1, y2].every(Number.isFinite)) return false;

    // 同一行文字的起点必须对齐（左对齐看 x，居中/右对齐也看 x）
    if (Math.abs(x1 - x2) > 0.75) return false;

    const gap = y2 - y1;
    const fs = Math.max(prev.fontSize, next.fontSize);
    if (gap < fs * 0.9 || gap > fs * 1.9) return false;

    // 水平投影需要有交集，避免把左右两栏误合并
    if (prev.aabb.x + prev.aabb.w < next.aabb.x || next.aabb.x + next.aabb.w < prev.aabb.x) {
      return false;
    }

    return true;
  }

  function compareDocumentOrder(a, b) {
    if (a.el === b.el) return 0;
    const position = a.el.compareDocumentPosition(b.el);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  /* ======================================================================
   * 命中检测
   * ==================================================================== */

  /**
   * 依据根用户坐标中的 AABB 命中，取面积最小者（最具体的标签优先）。
   * tolerance 为容差（用户单位），由调用方按当前缩放换算成屏幕约 2~3px。
   */
  function hitTest(entries, point, tolerance) {
    let best = null;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const box = entry.aabb;
      if (point.x >= box.x - tolerance && point.x <= box.x + box.w + tolerance &&
          point.y >= box.y - tolerance && point.y <= box.y + box.h + tolerance) {
        if (!best || entry.area < best.area) best = entry;
      }
    }
    return best;
  }

  /** 事件目标回退匹配：处理字形边缘、textPath 等包围盒不精确的情况 */
  function findEntryForElement(entries, node) {
    if (!node || node.nodeType !== 1) return null;
    for (let i = 0; i < entries.length; i += 1) {
      const parts = entries[i].parts;
      for (let j = 0; j < parts.length; j += 1) {
        const el = parts[j].el;
        if (el === node || (el.contains && el.contains(node))) return entries[i];
      }
    }
    return null;
  }

  /* ======================================================================
   * 高亮
   * ==================================================================== */

  /**
   * 高亮绘制在独立的覆盖 SVG 上（与主 SVG 共用同一 viewBox），
   * 因此不会改变原文档结构、样式或导出结果。
   */
  function createHighlighter(layer) {
    const doc = layer.ownerDocument;
    const group = doc.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'svg-text-selection');
    layer.appendChild(group);

    function clear() {
      while (group.firstChild) group.removeChild(group.firstChild);
    }

    function show(entry) {
      clear();
      entry.parts.forEach(function (part) {
        const matrix = part.matrix;

        // 直接使用元素自身的包围盒（本地坐标），通过矩阵映射到根坐标系。
        // 不做“屏幕像素补偿”：padding 若按用户单位换算，会在深度放大时被同步放大；
        // 描边则通过 vector-effect 保持 1.4px。
        const rect = doc.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', part.bbox.x.toFixed(3));
        rect.setAttribute('y', part.bbox.y.toFixed(3));
        rect.setAttribute('width', part.bbox.width.toFixed(3));
        rect.setAttribute('height', part.bbox.height.toFixed(3));
        rect.setAttribute('transform', 'matrix(' + [
          matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f
        ].join(' ') + ')');
        rect.setAttribute('fill', 'rgba(31, 111, 235, 0.12)');
        rect.setAttribute('stroke', '#1f6feb');
        rect.setAttribute('stroke-width', '1.4');
        rect.setAttribute('vector-effect', 'non-scaling-stroke');
        rect.setAttribute('stroke-dasharray', '4 3');
        rect.setAttribute('pointer-events', 'none');
        group.appendChild(rect);
      });
    }

    return { show: show, clear: clear };
  }

  global.TextModel = {
    buildTextIndex: buildTextIndex,
    extractText: extractText,
    hitTest: hitTest,
    findEntryForElement: findEntryForElement,
    createHighlighter: createHighlighter
  };
})(window);
