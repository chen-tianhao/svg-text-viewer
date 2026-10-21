/*!
 * svg-parser.js — SVG 文件解析、清洗、样式隔离、画布尺寸计算
 * 依赖：浏览器原生 DOMParser（无第三方库）
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  /** 单文件大小上限：避免一次性解析超大文件导致页面卡死 */
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  /** 可能执行脚本或加载外部资源的元素，载入前统一移除 */
  const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);

  /** 不在渲染树中的容器：其中的 text 不会被直接绘制（可能通过 <use> 复用） */
  const HIDDEN_CONTAINERS = new Set([
    'defs', 'symbol', 'clippath', 'mask', 'marker', 'pattern',
    'lineargradient', 'radialgradient', 'filter', 'style', 'script',
    'title', 'desc', 'metadata'
  ]);

  const UNIT_TO_PX = {
    '': 1,
    px: 1,
    pt: 4 / 3,
    pc: 16,
    mm: 96 / 25.4,
    cm: 96 / 2.54,
    in: 96
  };

  /** 统一的解析错误：message 为标题，detail 为可展开的技术细节 */
  class SvgParseError extends Error {
    constructor(message, detail) {
      super(message);
      this.name = 'SvgParseError';
      this.detail = detail || '';
    }
  }

  /* ======================================================================
   * 解析
   * ==================================================================== */

  /**
   * 将文本解析为 SVG 根元素。
   * 对“缺少 xmlns 声明”这类常见不规范导出做一次容错重试。
   */
  function parseSvgText(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    if (!source.trim()) {
      throw new SvgParseError('文件内容为空', '没有读取到任何 XML 内容，请确认文件是否完整。');
    }

    let doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    let errorNode = doc.querySelector('parsererror');

    if (errorNode) {
      const retried = retryWithNamespace(source);
      if (retried) {
        doc = retried;
        errorNode = null;
      }
    }

    if (errorNode) {
      throw new SvgParseError('SVG 语法错误', cleanParserError(errorNode.textContent));
    }

    const root = doc.documentElement;
    if (!root) {
      throw new SvgParseError('文件内容为空', '未找到任何根元素。');
    }
    if (root.localName.toLowerCase() === 'parsererror') {
      throw new SvgParseError('SVG 语法错误', cleanParserError(root.textContent));
    }
    if (root.localName.toLowerCase() !== 'svg') {
      throw new SvgParseError(
        '文件格式不符',
        `根元素是 <${root.localName}>，而不是 <svg>。请确认选择的是 SVG 文件。`
      );
    }
    // XML 解析器允许“无命名空间”的 <svg>，但这样的节点插入页面后不会渲染，
    // 因此这里补全 xmlns 后重新解析一次。
    if (!root.namespaceURI || root.namespaceURI !== SVG_NS) {
      const normalized = retryWithNamespace(source);
      if (normalized && normalized.documentElement) {
        return normalized.documentElement;
      }
      throw new SvgParseError(
        '文件格式不符',
        '根元素使用了非标准命名空间 ' + (root.namespaceURI || '(空)') + '，无法作为 SVG 渲染。'
      );
    }

    return root;
  }

  /**
   * 容错：部分工具导出的 SVG 省略了 xmlns / xmlns:xlink，
   * 浏览器按 XML 解析会直接报命名空间错误。补全后重试一次。
   */
  function retryWithNamespace(source) {
    if (!/<svg[\s>]/i.test(source)) return null;

    const patched = source.replace(/<svg\b[^>]*>/i, function (tag) {
      let extra = '';
      if (!/\sxmlns\s*=/.test(tag)) extra += ` xmlns="${SVG_NS}"`;
      if (!/\sxmlns:xlink\s*=/.test(tag)) extra += ` xmlns:xlink="${XLINK_NS}"`;
      return extra ? tag.replace(/\s*>$/, extra + '>') : tag;
    });

    if (patched === source) return null;

    const doc = new DOMParser().parseFromString(patched, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    if (!doc.documentElement || doc.documentElement.localName.toLowerCase() !== 'svg') return null;
    return doc;
  }

  /** 从浏览器各异的 parsererror 文本中提取“行/列 + 原因” */
  function cleanParserError(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();

    const chrome = text.match(/error on line (\d+) at column (\d+):\s*(.*?)(?:\s+Below is|$)/i);
    if (chrome) {
      return `第 ${chrome[1]} 行，第 ${chrome[2]} 列：${chrome[3].trim()}`;
    }

    const firefox = text.match(/Line number (\d+), column (\d+):\s*(.*)/i);
    if (firefox) {
      return `第 ${firefox[1]} 行，第 ${firefox[2]} 列：${firefox[3].trim()}`;
    }

    return text.slice(0, 320) || '未知的 XML 语法错误。';
  }

  /* ======================================================================
   * 清洗：移除脚本与外部可执行内容
   * ==================================================================== */

  function sanitize(root) {
    const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));

    nodes.forEach(function (el) {
      if (el !== root && BLOCKED_TAGS.has(el.localName.toLowerCase())) {
        el.remove();
        return;
      }

      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        const name = attr.name.toLowerCase();
        const value = attr.value || '';

        // 1) 所有 on* 事件属性（onclick / onload ...）
        if (name.indexOf('on') === 0) {
          el.removeAttributeNode(attr);
          return;
        }
        // 2) javascript: / data:text/html 形式的链接
        if ((name === 'href' || name === 'xlink:href' || name === 'src') &&
            /^\s*(?:javascript|data:text\/html)/i.test(value)) {
          el.removeAttributeNode(attr);
          return;
        }
        // 3) 旧式 CSS 表达式
        if (name === 'style' && /expression\s*\(|javascript:/i.test(value)) {
          el.removeAttributeNode(attr);
          return;
        }
        // 4) foreignObject 内的 HTML 不应抢占焦点或自动播放
        if (name === 'autofocus' || name === 'autoplay') {
          el.removeAttributeNode(attr);
        }
      });
    });

    // foreignObject 内的 HTML <style> 会脱离 SVG 样式作用域，统一移除更安全；
    // draw.io 等工具的 HTML 标签样式都写在 style 属性里，不受影响。
    Array.prototype.forEach.call(root.querySelectorAll('foreignObject style'), function (styleEl) {
      styleEl.remove();
    });
  }

  /* ======================================================================
   * 样式隔离
   *
   * SVG 内部的 <style> 一旦插入 HTML 文档就会成为全局样式，
   * 既可能与页面 UI 冲突，也可能被页面样式反向污染。
   * 这里把每条选择器都限定在画布容器之下，实现轻量级作用域隔离。
   * ==================================================================== */

  function scopeStyles(root, scopeSelector) {
    const styles = root.querySelectorAll('style');
    Array.prototype.forEach.call(styles, function (styleEl) {
      const css = styleEl.textContent || '';
      if (!css.trim()) return;
      styleEl.textContent = scopeCss(css, scopeSelector);
    });
  }

  /** 递归处理 CSS 规则，返回重写后的样式文本 */
  function scopeCss(css, scope) {
    const out = [];
    let i = 0;
    const n = css.length;

    function skipString() {
      const quote = css[i];
      i += 1;
      while (i < n) {
        if (css[i] === '\\') { i += 2; continue; }
        if (css[i] === quote) { i += 1; return; }
        i += 1;
      }
    }

    function skipComment() {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    }

    function parseRules() {
      while (i < n) {
        // 跳过空白与注释
        while (i < n) {
          if (/\s/.test(css[i])) { i += 1; continue; }
          if (css[i] === '/' && css[i + 1] === '*') { skipComment(); continue; }
          break;
        }
        if (i >= n) return;
        if (css[i] === '}') { i += 1; return; }

        // 读取选择器 / at-rule 前缀，直到 { } ;（忽略括号与字符串内的分隔符）
        const start = i;
        let paren = 0;
        while (i < n) {
          const ch = css[i];
          if (ch === '"' || ch === "'") { skipString(); continue; }
          if (ch === '/' && css[i + 1] === '*') { skipComment(); continue; }
          if (ch === '(') paren += 1;
          else if (ch === ')') paren = Math.max(0, paren - 1);
          else if (paren === 0 && (ch === '{' || ch === '}' || ch === ';')) break;
          i += 1;
        }

        const prelude = css.slice(start, i).trim();

        if (i >= n) { if (prelude) out.push(prelude); break; }

        if (css[i] === ';') {
          i += 1;
          // 丢弃 @import / @charset，避免引入外部样式
          if (prelude && !/^@(import|charset)\b/i.test(prelude)) out.push(prelude + ';');
          continue;
        }
        if (css[i] === '}') { i += 1; return; }

        // 读取 { ... } 块（支持嵌套）
        i += 1;
        const blockStart = i;
        let depth = 1;
        while (i < n && depth > 0) {
          const ch = css[i];
          if (ch === '"' || ch === "'") { skipString(); continue; }
          if (ch === '/' && css[i + 1] === '*') { skipComment(); continue; }
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
          i += 1;
        }
        const block = css.slice(blockStart, i - 1);

        if (!prelude) continue;

        if (prelude.charAt(0) === '@') {
          if (/^@(media|supports|layer|container|scope|document)\b/i.test(prelude)) {
            out.push(prelude + '{' + scopeCss(block, scope) + '}');
          } else if (/^@(import|charset)\b/i.test(prelude)) {
            // 直接丢弃
          } else {
            // @font-face / @keyframes 等原样保留
            out.push(prelude + '{' + block + '}');
          }
        } else {
          const scopedSelector = scopeSelectorList(prelude, scope);
          // 所有选择器都被丢弃（例如 html/body）时，整条规则一并跳过
          if (scopedSelector) out.push(scopedSelector + '{' + block + '}');
        }
      }
    }

    parseRules();
    return out.join('\n');
  }

  function scopeSelectorList(list, scope) {
    return splitTopLevel(list, ',').map(function (selector) {
      return scopeSelector(selector, scope);
    }).filter(Boolean).join(', ');
  }

  function scopeSelector(selector, scope) {
    const s = selector.trim();
    if (!s) return '';

    // html / body 在 SVG 文档中并不存在。若把它们映射到根 <svg>，
    // 一条 body { background: red } 就会刷满整张画布，因此直接丢弃。
    if (/^(html|body)(?=[\s>+~.#[:]|$)/i.test(s)) return '';

    // :root / svg 指向根 <svg>，保留并限定在画布容器内
    if (/^(:root|svg)(?=[\s>+~.#[:]|$)/i.test(s)) {
      return s.replace(/^(:root|svg)/i, scope + ' > svg');
    }
    if (s.indexOf(scope) === 0) return s;

    return scope + ' ' + s;
  }

  /** 按顶层分隔符切分（忽略引号、括号、方括号内的分隔符） */
  function splitTopLevel(input, separator) {
    const parts = [];
    let start = 0;
    let paren = 0;
    let bracket = 0;
    let quote = null;

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') paren += 1;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket += 1;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === separator && paren === 0 && bracket === 0) {
        parts.push(input.slice(start, i));
        start = i + 1;
      }
    }

    parts.push(input.slice(start));
    return parts;
  }

  /* ======================================================================
   * 挂载与尺寸
   * ==================================================================== */

  /**
   * 让 SVG 铺满容器；真正的显示范围由视口改写 viewBox 控制。
   * 因此缩放时浏览器会按当前缩放级别重新栅格化矢量，而不是放大位图。
   */
  function attach(svg) {
    // 注意：不要覆盖 width / height 属性。
    // 没有 viewBox 的 SVG 需要靠这两个属性推导画布范围；
    // 实际显示尺寸由下面的 CSS 100% 控制（CSS 几何属性优先于属性值）。
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.removeAttribute('x');
    svg.removeAttribute('y');

    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.maxWidth = 'none';
    svg.style.maxHeight = 'none';
    svg.style.display = 'block';
    svg.style.overflow = 'hidden';
    svg.style.userSelect = 'none';

    // draw.io 等工具会同时输出 light / dark 两套颜色（light-dark()）。
    // 应用外壳是深色主题，若不锁定，SVG 会跟随系统变成深底，
    // 与浅色画布和默认黑色文字冲突。这里固定使用 light 变体。
    svg.style.colorScheme = 'light';
  }

  /** 计算 SVG 的基础用户坐标系范围 */
  function resolveBaseBox(svg) {
    const viewBox = parseViewBox(svg.getAttribute('viewBox'));
    if (viewBox) return viewBox;

    const width = parseLength(svg.getAttribute('width'));
    const height = parseLength(svg.getAttribute('height'));
    if (width > 0 && height > 0) {
      return { x: 0, y: 0, w: width, h: height };
    }

    // 没有 viewBox 也没有尺寸：退化为内容包围盒
    try {
      const box = svg.getBBox();
      if (box && box.width > 0 && box.height > 0) {
        const pad = Math.max(box.width, box.height) * 0.02;
        return {
          x: box.x - pad,
          y: box.y - pad,
          w: box.width + pad * 2,
          h: box.height + pad * 2
        };
      }
    } catch (err) {
      /* getBBox 在未渲染时可能抛错，交给上层提示 */
    }

    return null;
  }

  function parseViewBox(value) {
    if (!value) return null;
    const nums = String(value).trim().split(/[\s,]+/).map(Number);
    if (nums.length !== 4 || nums.some(function (n) { return !Number.isFinite(n); })) return null;
    if (nums[2] <= 0 || nums[3] <= 0) return null;
    return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
  }

  function parseLength(value) {
    if (!value) return NaN;
    const match = String(value).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)$/i);
    if (!match) return NaN;
    const unit = match[2].toLowerCase();
    if (unit === '%') return NaN;
    const factor = UNIT_TO_PX[unit];
    if (!factor) return NaN;
    return parseFloat(match[1]) * factor;
  }

  global.SvgDoc = {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    HIDDEN_CONTAINERS: HIDDEN_CONTAINERS,
    SvgParseError: SvgParseError,
    parseSvgText: parseSvgText,
    sanitize: sanitize,
    scopeStyles: scopeStyles,
    attach: attach,
    resolveBaseBox: resolveBaseBox,
    parseViewBox: parseViewBox
  };
})(window);
