/*!
 * viewport.js — 平移 / 缩放视口
 *
 * 实现方式：不缩放 DOM，而是改写 SVG 的 viewBox。
 * 每次缩放都让浏览器按新的视口重新渲染矢量图形，因此放大后线条依旧锐利，
 * 也不会出现 CSS transform 放大导致的位图模糊、内容溢出容器等问题。
 */
(function (global) {
  'use strict';

  const MIN_RATIO = 0.06;   // 相对“适应窗口”的最小缩放
  const MAX_RATIO = 32;     // 相对“适应窗口”的最大缩放
  const CLICK_SLOP = 4;     // 拖动超过该像素数即视为平移，不再触发点击

  function createViewport(options) {
    const stage = options.stage;
    const targets = options.targets || [];
    const base = {
      x: options.baseBox.x,
      y: options.baseBox.y,
      w: options.baseBox.w,
      h: options.baseBox.h
    };
    const padding = options.padding == null ? 28 : options.padding;

    const view = { x: base.x, y: base.y, w: base.w, h: base.h };

    let active = true;
    let dragging = false;
    let lastPointer = null;
    let dragDistance = 0;
    let hasAdjusted = false;
    let lastStageSize = { w: 0, h: 0 };

    const disposers = [];

    function listen(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      disposers.push(function () {
        target.removeEventListener(type, handler, opts);
      });
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function measure() {
      const rect = stage.getBoundingClientRect();
      lastStageSize = { w: rect.width, h: rect.height };
      return rect;
    }

    /** “适应窗口”对应的缩放比（像素 / 用户单位） */
    function fitScaleOf(size) {
      if (!size.w || !size.h) return 0;
      const sx = (size.w - padding * 2) / base.w;
      const sy = (size.h - padding * 2) / base.h;
      const scale = Math.min(sx, sy);
      return scale > 0 ? scale : 1e-6;
    }

    function getScale() {
      if (!lastStageSize.w) measure();
      return lastStageSize.w / view.w;
    }

    function getRatio() {
      const fit = fitScaleOf(lastStageSize);
      if (!fit) return 1;
      return getScale() / fit;
    }

    function round(value) {
      return Math.round(value * 1000) / 1000;
    }

    function apply() {
      const rect = measure();
      if (!rect.width || !rect.height) return;

      const viewBox = [
        round(view.x), round(view.y), round(view.w), round(view.h)
      ].join(' ');

      targets.forEach(function (target) {
        target.setAttribute('viewBox', viewBox);
      });

      if (typeof options.onChange === 'function') {
        options.onChange({
          x: view.x,
          y: view.y,
          w: view.w,
          h: view.h,
          scale: getScale(),
          ratio: getRatio(),
          fitScale: fitScaleOf(lastStageSize)
        });
      }
    }

    /** 限制平移范围：至少保留约半个视口的内容，避免把整张图拖丢 */
    function clampView() {
      const marginX = view.w * 0.5;
      const marginY = view.h * 0.5;
      view.x = clamp(view.x, base.x - marginX, base.x + base.w + marginX - view.w);
      view.y = clamp(view.y, base.y - marginY, base.y + base.h + marginY - view.h);
    }

    function fit() {
      if (!active) return;
      const rect = measure();
      if (rect.width < 2 || rect.height < 2) return;

      const scale = fitScaleOf({ w: rect.width, h: rect.height });
      view.w = rect.width / scale;
      view.h = rect.height / scale;
      view.x = base.x + base.w / 2 - view.w / 2;
      view.y = base.y + base.h / 2 - view.h / 2;
      hasAdjusted = false;

      clampView();
      apply();
    }

    function zoomAt(clientX, clientY, factor) {
      if (!active) return;

      const rect = measure();
      if (!rect.width || !rect.height) return;

      const fit = fitScaleOf({ w: rect.width, h: rect.height });
      const current = rect.width / view.w;
      const min = Math.max(fit * MIN_RATIO, 1e-6);
      const max = fit * MAX_RATIO;

      const next = clamp(current * factor, min, max);
      if (Math.abs(next - current) < 1e-9) return;

      const anchor = clientToUser(clientX, clientY);
      const ratio = current / next;

      view.w *= ratio;
      view.h *= ratio;
      view.x = anchor.x - (anchor.x - view.x) * ratio;
      view.y = anchor.y - (anchor.y - view.y) * ratio;
      hasAdjusted = true;

      clampView();
      apply();
    }

    function zooms(factor) {
      const rect = measure();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    }

    function panBy(dxPx, dyPx) {
      if (!active || !lastStageSize.w || !lastStageSize.h) return;
      view.x -= dxPx * (view.w / lastStageSize.w);
      view.y -= dyPx * (view.h / lastStageSize.h);
      hasAdjusted = true;
      clampView();
      apply();
    }

    /** 屏幕坐标（clientX/Y）→ 根 SVG 用户坐标 */
    function clientToUser(clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: view.x, y: view.y };
      return {
        x: view.x + ((clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((clientY - rect.top) / rect.height) * view.h
      };
    }

    function getViewBox() {
      return { x: view.x, y: view.y, w: view.w, h: view.h };
    }

    /* ---------------- 交互 ---------------- */

    function onPointerDown(event) {
      if (!active || event.button !== 0) return;
      if (event.target && event.target.closest &&
          event.target.closest('a')) {
        // 链接由 click 阶段处理，这里仍然允许拖拽
      }
      dragging = true;
      dragDistance = 0;
      lastPointer = { x: event.clientX, y: event.clientY };
      stage.classList.add('is-panning');

      try {
        stage.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 某些合成事件没有可捕获的指针 */
      }
    }

    function onPointerMove(event) {
      if (!active || !dragging || !lastPointer) return;
      const dx = event.clientX - lastPointer.x;
      const dy = event.clientY - lastPointer.y;
      if (!dx && !dy) return;

      dragDistance += Math.abs(dx) + Math.abs(dy);
      lastPointer = { x: event.clientX, y: event.clientY };
      event.preventDefault();
      panBy(dx, dy);
    }

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      lastPointer = null;
      stage.classList.remove('is-panning');
      try {
        if (stage.hasPointerCapture(event.pointerId)) {
          stage.releasePointerCapture(event.pointerId);
        }
      } catch (err) {
        /* 忽略 */
      }
    }

    function onWheel(event) {
      if (!active) return;
      event.preventDefault();

      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      else if (event.deltaMode === 2) delta *= 400;

      const factor = clamp(Math.exp(-delta * 0.0018), 0.4, 2.5);
      zoomAt(event.clientX, event.clientY, factor);
    }

    /** 返回 true 表示本次点击来自拖动，应当忽略 */
    function consumeClickSuppression() {
      const suppressed = dragDistance > CLICK_SLOP;
      dragDistance = 0;
      return suppressed;
    }

    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function () {
        if (!active) return;

        // 先记录旧尺寸，再测量新尺寸：缩放比必须基于旧值计算
        const previousSize = lastStageSize;
        const rect = measure();
        if (rect.width < 2 || rect.height < 2) return;

        if (!hasAdjusted || !previousSize.w) {
          fit();
          return;
        }

        // 窗口尺寸变化时保持当前缩放比与中心点
        const scale = previousSize.w / view.w;
        const centerX = view.x + view.w / 2;
        const centerY = view.y + view.h / 2;

        view.w = rect.width / scale;
        view.h = rect.height / scale;
        view.x = centerX - view.w / 2;
        view.y = centerY - view.h / 2;
        clampView();
        apply();
      });
      resizeObserver.observe(stage);
    }

    listen(stage, 'pointerdown', onPointerDown);
    listen(stage, 'pointermove', onPointerMove);
    listen(stage, 'pointerup', endDrag);
    listen(stage, 'pointercancel', endDrag);
    listen(stage, 'wheel', onWheel, { passive: false });
    listen(stage, 'dragstart', function (event) { event.preventDefault(); });

    return {
      fit: fit,
      zoomAt: zoomAt,
      zoomBy: zooms,
      panBy: panBy,
      clientToUser: clientToUser,
      getScale: getScale,
      getRatio: getRatio,
      getViewBox: getViewBox,
      consumeClickSuppression: consumeClickSuppression,
      destroy: function () {
        active = false;
        if (resizeObserver) resizeObserver.disconnect();
        disposers.forEach(function (dispose) { dispose(); });
        disposers.length = 0;
        stage.classList.remove('is-panning');
      }
    };
  }

  global.Viewport = { create: createViewport };
})(window);
