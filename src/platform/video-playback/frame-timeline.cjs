(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoFrameTimeline = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const frameAt = (points, time) => {
    let low = 0, high = points.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (points[mid] <= time + 1e-9) low = mid; else high = mid - 1; }
    return clamp(low, 0, points.length - 2);
  };
  const nearest = (points, time) => {
    const index = frameAt(points, time);
    return Math.abs(time - points[index]) <= Math.abs(points[index + 1] - time) ? index : index + 1;
  };
  const clock = value => { const ms = Math.max(0, Math.round(value * 1000)); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
  const validRate = value => Number.isFinite(value) && value >= 1 && value <= 1000 ? value : 0;
  // Non-drop timecode numbers frames at the nominal source rate. Fractional
  // rates retain their rational timing; indexed seeks use actual presentation PTS.
  const formatTimecode = (frame, rate) => {
    const base = Math.round(validRate(rate)); if (!base) return '--:--:--:--';
    const number = Math.max(0, Math.floor(frame)), seconds = Math.floor(number / base);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, number % base].map(value => String(value).padStart(2, '0')).join(':');
  };
  const parseTimecode = (value, rate) => {
    const base = Math.round(validRate(rate));
    if (!base) throw new Error('正在读取素材帧率，请稍后输入时间码');
    const match = /^(\d{2,3}):(\d{2}):(\d{2}):(\d{2,3})$/.exec(String(value).trim());
    if (!match) throw new Error('请输入时:分:秒:帧，例如 00:00:12:15');
    const [hours, minutes, seconds, frames] = match.slice(1).map(Number);
    if (minutes > 59 || seconds > 59 || frames >= base) throw new Error(`分钟、秒须小于 60，帧须为 00–${base - 1}`);
    return ((hours * 60 + minutes) * 60 + seconds) * base + frames;
  };
  const constantRate = points => {
    if (points.length < 3) return 0;
    const interval = points[1] - points[0];
    return points.slice(1).every((value, i) => Math.abs(value - points[i] - interval) < interval * .001) ? validRate(1 / interval) : 0;
  };
  function mountTimecode({ node, read, seekOrdinal, step, onError }) {
    if (!node) return null;
    const group = document.createElement('div'); group.className = 'timecode-transport';
    node.before(group); group.append(node); node.replaceChildren();
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', '当前时间码');
    let dirty = false, invalid = false;
    const units = ['hours', 'minutes', 'seconds', 'frames'], labels = ['时', '分', '秒', '帧'];
    const inputs = units.map((unit, index) => {
      if (index) { const colon = document.createElement('span'); colon.className = 'timecode-colon'; colon.textContent = ':'; colon.setAttribute('aria-hidden', 'true'); node.append(colon); }
      const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.spellcheck = false;
      input.dataset.timecodePart = unit; input.maxLength = index === 0 || index === 3 ? 3 : 2;
      input.setAttribute('aria-label', `时间码：${labels[index]}`); input.setAttribute('role', 'spinbutton'); input.setAttribute('aria-valuemin', '0'); input.value = '00';
      node.append(input); return input;
    });
    const buttons = [-1, 1].map(direction => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'timecode-step'; button.dataset.playerStep = String(direction);
      button.setAttribute('aria-label', direction < 0 ? '上一帧' : '下一帧'); button.title = direction < 0 ? '上一帧' : '下一帧';
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); arrow.setAttribute('viewBox', '0 0 16 16'); arrow.setAttribute('width', '12'); arrow.setAttribute('height', '12'); arrow.setAttribute('aria-hidden', 'true');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); line.setAttribute('points', direction < 0 ? '10,3 5,8 10,13' : '6,3 11,8 6,13'); line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '1.8'); line.setAttribute('stroke-linecap', 'round'); line.setAttribute('stroke-linejoin', 'round'); arrow.append(line); button.append(arrow); group.append(button);
      button.onclick = () => { clearError(); dirty = false; step(direction); update(true); }; return button;
    });
    function clearError() { invalid = false; node.removeAttribute('aria-invalid'); inputs.forEach(input => { input.removeAttribute('aria-invalid'); input.setCustomValidity(''); }); }
    function update(force = false) {
      const state = read(), base = Math.round(validRate(state.rate)), enabled = state.enabled && Boolean(base);
      inputs.forEach((input, index) => {
        input.disabled = !enabled; input.setAttribute('aria-valuemax', String(index === 0 ? 999 : index === 3 ? Math.max(0, base - 1) : 59));
        input.style.width = `${index === 0 ? Math.max(2, state.value.split(':')[0].length) : index === 3 ? Math.max(2, String(Math.max(0, base - 1)).length) : 2}ch`;
      });
      buttons[0].disabled = !enabled || state.ordinal <= 0; buttons[1].disabled = !enabled || state.ordinal >= state.last;
      if (!force && (node.contains(document.activeElement) || invalid)) return;
      state.value.split(':').forEach((value, index) => { inputs[index].value = value; inputs[index].setAttribute('aria-valuenow', String(Number(value) || 0)); });
    }
    function ordinal() {
      if (inputs.some(input => !/^\d{1,3}$/.test(input.value))) throw new Error('请分别输入时、分、秒、帧数字');
      return parseTimecode(inputs.map(input => input.value.padStart(2, '0')).join(':'), read().rate);
    }
    function commit() {
      if (!dirty) return true;
      try { seekOrdinal(ordinal()); dirty = false; clearError(); update(true); return true; }
      catch (error) { invalid = true; node.setAttribute('aria-invalid', 'true'); node.title = error.message; const input = inputs.find(item => item === document.activeElement) || inputs[0]; input.setAttribute('aria-invalid', 'true'); input.setCustomValidity(error.message); onError(error.message); return false; }
    }
    inputs.forEach((input, index) => {
      input.onfocus = () => input.select();
      input.onbeforeinput = event => { if (event.data && /\D/.test(event.data)) event.preventDefault(); };
      input.oninput = () => { input.value = input.value.replace(/\D/g, '').slice(0, input.maxLength); dirty = true; clearError(); };
      input.onkeydown = event => {
        if (!['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { dirty = false; clearError(); update(true); input.blur(); return; }
        if (event.key === 'Enter') { if (commit()) input.blur(); return; }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { inputs[clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, 3)].focus(); return; }
        try {
          const state = read(), base = Math.round(state.rate), amount = [3600 * base, 60 * base, base, 1][index] * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
          seekOrdinal(clamp(ordinal() + amount, 0, state.last)); dirty = false; clearError(); update(true); input.select();
        } catch { dirty = true; commit(); }
      };
    });
    const blur = event => { if (!node.contains(event.relatedTarget)) { if (commit()) update(true); } };
    node.addEventListener('focusout', blur);
    return { update, reset() { dirty = false; clearError(); update(true); }, destroy() { node.removeEventListener('focusout', blur); inputs.forEach(input => { input.onfocus = input.oninput = input.onkeydown = input.onbeforeinput = null; }); buttons.forEach(button => button.onclick = null); } };
  }
  const defaultRange = (points, time, seconds = 5) => {
    const start = frameAt(points, time);
    const end = clamp(nearest(points, Math.min(points.at(-1), points[start] + seconds)), start + 1, points.length - 1);
    return { start: points[start], end: points[end] };
  };
  const moveInterval = (points, mark, target) => {
    const duration = mark.end - mark.start, last = points.at(-1);
    let start = clamp(nearest(points, clamp(target, points[0], Math.max(points[0], last - duration))), 0, points.length - 2);
    if (points[start] + duration > last) start = frameAt(points, Math.max(points[0], last - duration));
    const end = clamp(nearest(points, points[start] + duration), start + 1, points.length - 1);
    return { ...mark, start: points[start], end: points[end] };
  };
  // noUiSlider's public documentElement option scopes document-level drag
  // listeners. End only this slider's gesture on Escape/reset, never broadcast
  // a mouseup that could terminate another control's interaction.
  function eventScope() {
    const target = document.documentElement, listeners = new Set();
    return {
      element: {
        addEventListener(type, listener, options) { listeners.add({ type, listener, options }); target.addEventListener(type, listener, options); },
        removeEventListener(type, listener) { for (const entry of listeners) if (entry.type === type && entry.listener === listener) { target.removeEventListener(type, listener, entry.options); listeners.delete(entry); } },
      },
      end() { const entry = [...listeners].find(item => /^(mouseup|pointerup|MSPointerUp)$/.test(item.type)); if (entry) entry.listener(new MouseEvent(entry.type, { buttons: 0 })); },
      dispose() { for (const entry of listeners) target.removeEventListener(entry.type, entry.listener, entry.options); listeners.clear(); },
    };
  }
  function mountTrim({ node, library, model, seek, onChange, onEnd }) {
    const scope = eventScope();
    let range = null, gesture = null, moving = false, raf = 0, preview = null, disposed = false, maximum = 1, disabled = null;
    const value = () => range || { start: 0, end: Math.max(0, model().duration) };
    const api = library.create(node, { start: [0, 1], range: { min: 0, max: 1 }, connect: true, behaviour: 'drag', animate: false, keyboardSupport: false, documentElement: scope.element, format: { to: String, from: Number } });
    const handles = [...node.querySelectorAll('.noUi-handle')], body = node.querySelector('.noUi-connect');
    body.classList.add('trim-range-body'); body.setAttribute('role', 'button'); body.setAttribute('aria-label', '整体移动裁剪范围');
    handles.forEach((handle, i) => { handle.dataset.edge = i ? 'out' : 'in'; handle.classList.add('timeline-endcap', i ? 'end' : 'start'); handle.setAttribute('aria-label', i ? '裁剪出点' : '裁剪入点'); });
    const update = () => {
      if (disposed) return;
      const next = Math.max(.000001, model().duration || 1), unavailable = !(model().duration > 0);
      if (next !== maximum && !gesture) { maximum = next; api.updateOptions({ range: { min: 0, max: maximum } }, false); }
      if (unavailable !== disabled) { disabled = unavailable; disabled ? api.disable() : api.enable(); }
      body.tabIndex = disabled ? -1 : 0;
      const span = value(), actual = api.get(true);
      if (!gesture && (Math.abs(actual[0] - span.start) > 1e-9 || Math.abs(actual[1] - span.end) > 1e-9)) api.set([span.start, span.end], false);
      handles.forEach((handle, i) => { const position = i ? span.end : span.start; handle.setAttribute('aria-valuetext', clock(position)); handle.title = `${i ? '裁剪出点' : '裁剪入点'} ${clock(position)}；拖动调整，方向键微调`; });
      node.dataset.start = String(span.start); node.dataset.end = String(span.end);
    };
    const emit = () => { update(); onChange(value()); };
    const adjust = (before, target, edge, translate = false) => {
      const { points, duration, rate } = model(), count = points.length - 1;
      if (translate) {
        if (count > 0) return moveInterval(points, before, target);
        const width = before.end - before.start, start = clamp(target, 0, Math.max(0, duration - width)); return { start, end: start + width };
      }
      if (count > 0) {
        const start = clamp(nearest(points, before.start), 0, count - 1), end = clamp(nearest(points, before.end), start + 1, count);
        return edge === 'in' ? { ...before, start: points[clamp(nearest(points, target), 0, end - 1)] } : { ...before, end: points[clamp(nearest(points, target), start + 1, count)] };
      }
      const gap = Math.min(rate ? 1 / rate : .001, before.end - before.start);
      return edge === 'in' ? { ...before, start: clamp(target, 0, before.end - gap) } : { ...before, end: clamp(target, before.start + gap, duration) };
    };
    const previewTime = (span, edge) => {
      const { points } = model();
      return edge === 'out' ? points.length > 1 ? points[Math.max(0, nearest(points, span.end) - 1)] : Math.max(span.start, span.end - .000001) : span.start;
    };
    const stopPreview = () => { cancelAnimationFrame(raf); raf = 0; preview = null; };
    const capture = event => { moving = Boolean(event.target.closest('.noUi-connect')); };
    node.addEventListener('mousedown', capture, true); node.addEventListener('touchstart', capture, { capture: true, passive: true });
    api.on('start.trim', (_values, handle) => { if (disabled || disposed) return; gesture = { before: { ...value() }, time: model().time, edge: handle ? 'out' : 'in', moving, cancelled: false }; });
    api.on('slide.trim', (_values, handle, values) => {
      if (!gesture || gesture.cancelled || disabled || disposed) return;
      const edge = handle ? 'out' : 'in'; range = adjust(gesture.before, values[gesture.moving ? 0 : handle], edge, gesture.moving);
      api.set([range.start, range.end], false); emit();
      preview = previewTime(range, gesture.moving ? 'in' : edge);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (preview !== null) seek(preview); preview = null; });
    });
    api.on('end.trim', () => {
      if (!gesture || disposed) return;
      const action = gesture; gesture = null; stopPreview();
      if (action.cancelled) range = action.before;
      emit(); seek(action.cancelled ? action.time : previewTime(value(), action.moving ? 'in' : action.edge)); onEnd();
    });
    const cancel = () => { if (gesture) { gesture.cancelled = true; scope.end(); } };
    const key = event => {
      if (disabled || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { cancel(); return; }
      const edge = event.target.closest('[data-edge]')?.dataset.edge || 'in', translate = event.target === body, before = value(), { points, duration, rate } = model();
      const step = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1), position = edge === 'in' ? before.start : before.end;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? duration : points.length > 1 ? points[clamp(nearest(points, position) + step, 0, points.length - 1)] : position + step * (rate ? 1 / rate : .1);
      range = adjust(before, target, edge, translate); emit(); seek(previewTime(range, translate ? 'in' : edge));
    };
    node.addEventListener('keydown', key, true); node.addEventListener('pointercancel', cancel, true); node.addEventListener('touchcancel', cancel, true);
    return {
      value, update, dragging: () => Boolean(gesture),
      setRange(start, end) { if (gesture) return; range = { start, end }; update(); },
      setPoint(edge, position) {
        const { points, duration, rate } = model(); if (!(duration > 0)) return;
        const before = value(), count = points.length - 1, frame = count > 0 ? frameAt(points, position) : -1;
        const gap = Math.min(duration, rate ? 1 / rate : .001);
        if (edge === 'in') { const start = frame >= 0 ? points[frame] : clamp(position, 0, duration - gap); range = { start, end: Math.max(before.end, frame >= 0 ? points[frame + 1] : start + gap) }; }
        else { const end = frame >= 0 ? points[frame + 1] : clamp(position, gap, duration); range = { start: Math.min(before.start, frame >= 0 ? points[frame] : end - gap), end }; }
        emit();
      },
      reset() { gesture = null; scope.end(); stopPreview(); range = null; update(); },
      destroy() { disposed = true; gesture = null; stopPreview(); scope.end(); scope.dispose(); api.off('.trim'); api.destroy(); node.removeEventListener('mousedown', capture, true); node.removeEventListener('touchstart', capture, true); node.removeEventListener('keydown', key, true); node.removeEventListener('pointercancel', cancel, true); node.removeEventListener('touchcancel', cancel, true); },
    };
  }
  function mount({ root, seek, commitMark, deleteMark, onTrimChange = () => {}, onError = () => {} }) {
    const library = globalThis.noUiSlider;
    if (!library?.create) throw new Error('noUiSlider 进度条组件未加载，请重新打开插件');
    const track = root.querySelector('#frame-track'), layer = root.querySelector('#progress-marks'), playElement = root.querySelector('#progress-slider');
    let points = [], queuedPoints = null, sourceRate = 0, inferredRate = 0, duration = 0, time = 0, marks = [], activeId = '', pending = null, busy = false, epoch = 0, status = '正在读取帧索引…', seekFrame = 0, seekTarget = null, player = null, gesture = null, trimController = null, timecodeEditor = null, editorEnabled = true;
    const sliders = new Map();
    const count = () => Math.max(0, points.length - 1);
    const length = () => count() ? points.at(-1) : duration;
    const rate = () => sourceRate || inferredRate;
    const ordinal = () => count() ? frameAt(points, time) : Math.floor(Math.max(0, time) * rate() + 1e-6);
    const lastOrdinal = () => Math.max(0, (count() || Math.ceil(length() * rate())) - 1);
    const seekOrdinal = frame => { if (frame < 0 || frame > lastOrdinal()) throw new Error('时间码超出视频帧范围'); jump(count() ? points[frame] : frame / rate()); };
    const stepFrame = direction => { if (available() && editorEnabled && rate()) seekOrdinal(clamp(ordinal() + direction, 0, lastOrdinal())); };
    const available = () => length() > 0;
    const snapTime = value => count() ? points[clamp(nearest(points, value), 0, count() - 1)] : value;
    const currentMark = id => marks.find(item => item.id === id);
    function jump(value) {
      if (!available()) return;
      if (!count()) { time = clamp(value, 0, length()); seek(time); draw(); return; }
      const index = clamp(nearest(points, value), 0, count() - 1); time = points[index];
      seek(time + Math.min(.000001, (points[index + 1] - time) / 10)); draw();
    }
    function scheduleSeek(value) {
      seekTarget = value;
      if (!seekFrame) seekFrame = requestAnimationFrame(() => { seekFrame = 0; const next = seekTarget; seekTarget = null; if (next !== null) jump(next); });
    }
    function stopSeek() { cancelAnimationFrame(seekFrame); seekFrame = 0; seekTarget = null; }
    function setValues(record, values) {
      const actual = [].concat(record.api.get(true));
      if (actual.length === values.length && actual.every((value, index) => Math.abs(Number(value) - values[index]) < 1e-10)) return;
      record.api.set(values, false);
    }
    function availability(record) {
      const disabled = !available() || busy;
      if (record.disabled !== disabled) { record.disabled = disabled; disabled ? record.api.disable() : record.api.enable(); }
      if (record.body) { record.body.tabIndex = disabled ? -1 : 0; record.body.setAttribute('aria-disabled', String(disabled)); }
    }
    function annotate(record, mark) {
      if (!record.markId) {
        const frame = count() ? frameAt(points, time) : 0;
        const label = count() ? `第 ${frame + 1} / ${count()} 帧 · ${clock(points[frame])}` : available() ? clock(time) : status;
        const hint = count() ? '方向键逐帧调整' : '方向键调整 0.1 秒';
        track.setAttribute('aria-disabled', String(!available() || busy)); track.setAttribute('aria-valuemin', count() ? 1 : 0); track.setAttribute('aria-valuemax', count() || length() || 1); track.setAttribute('aria-valuenow', count() ? frame + 1 : time); track.setAttribute('aria-valuetext', label); track.title = `${label}；点击定位，${hint}`;
        record.handles[0].setAttribute('aria-label', `视频进度，${hint}`); record.handles[0].setAttribute('aria-valuetext', label);
        return;
      }
      if (!mark) return;
      const ordinal = marks.findIndex(item => item.id === mark.id) + 1;
      record.node.classList.toggle('active', activeId === mark.id);
      const label = `标记 ${ordinal} · ${clock(mark.start)} → ${clock(mark.end)}`;
      if (record.pin) { record.pin.style.left = `${length() ? mark.start / length() * 100 : 0}%`; record.pin.setAttribute('aria-label', `跳转到${label}`); record.pin.title = label; record.pin.disabled = !available() || busy; }
      record.body.setAttribute('aria-label', label); record.body.title = label + '；拖动移动，拖动两端调整，方向键逐帧微调';
      record.handles.forEach((handle, index) => { const edge = index ? 'end' : 'start'; handle.setAttribute('aria-label', `标记 ${ordinal} ${index ? '终点' : '起点'}`); handle.setAttribute('aria-valuetext', `${clock(mark[edge])}${count() ? ` · 帧边界 ${nearest(points, mark[edge])}` : ''}`); });
    }
    function normalized(record, values, handle) {
      const before = record.gesture?.before || currentMark(record.markId);
      if (!count()) {
        const step = Math.min(.001, length(), before.end - before.start);
        if (record.gesture?.moving) { const width = before.end - before.start, start = clamp(values[0], 0, Math.max(0, length() - width)); return { ...before, start, end: start + width }; }
        return handle ? { ...before, end: clamp(values[1], before.start + step, length()) } : { ...before, start: clamp(values[0], 0, before.end - step) };
      }
      const start = clamp(nearest(points, before.start), 0, count() - 1), end = clamp(nearest(points, before.end), start + 1, count());
      if (record.gesture?.moving) return moveInterval(points, before, values[0]);
      return handle ? { ...before, end: points[clamp(nearest(points, values[1]), start + 1, count())] } : { ...before, start: points[clamp(nearest(points, values[0]), 0, end - 1)] };
    }
    async function commit(before, after) {
      if (busy || !after || Math.abs(before.start - after.start) < 1e-9 && Math.abs(before.end - after.end) < 1e-9) return;
      const ticket = epoch; busy = true; pending = after; draw();
      try { await commitMark({ id: before.id, start: after.start, end: after.end, expectedStart: before.start, expectedEnd: before.end }); }
      catch (error) { if (ticket === epoch) onError(error.message); }
      finally { if (ticket === epoch) { busy = false; pending = null; draw(); } }
    }
    function dispose(record) {
      record.disposed = true; record.scope.end(); record.scope.dispose(); record.api.off('.frame'); record.api.destroy();
      record.node.removeEventListener('mousedown', record.captureIntent, true); record.node.removeEventListener('touchstart', record.captureIntent, true);
      if (record.markId) record.node.remove(); if (gesture === record) gesture = null;
    }
    function makeSlider(node, mark = null) {
      const scope = eventScope(), record = { node, markId: mark?.id || '', scope, api: null, handles: [], body: null, disabled: null, gesture: null, moving: false, disposed: false, range: Math.max(.000001, length() || 1) };
      record.api = library.create(node, { start: mark ? [mark.start, mark.end] : [time], range: { min: 0, max: record.range }, connect: mark ? true : [true, false], behaviour: mark ? 'drag' : 'snap', animate: false, animationDuration: 0, keyboardSupport: false, documentElement: scope.element, format: { to: value => String(value), from: Number } });
      record.handles = [...node.querySelectorAll('.noUi-handle')];
      if (mark) {
        record.body = node.querySelector('.noUi-connect'); record.body.classList.add('progress-mark-body'); record.body.setAttribute('role', 'button');
        record.handles.forEach((handle, index) => { handle.dataset.edge = index ? 'end' : 'start'; handle.classList.add('progress-mark-edge', index ? 'end' : 'start'); });
        const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'progress-mark-pin';
        const glyph = document.createElement('span'); glyph.className = 'marker-drop'; glyph.setAttribute('aria-hidden', 'true'); pin.append(glyph);
        pin.addEventListener('mousedown', event => event.stopPropagation()); pin.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
        pin.addEventListener('click', event => { event.stopPropagation(); const current = currentMark(mark.id); if (current && available() && !busy) { activeId = mark.id; jump(current.start); draw(); } });
        node.append(pin); record.pin = pin;
      }
      // Only identify which native noUiSlider gesture started; all pointer
      // movement, connected-range dragging and constraints belong to the library.
      const captureIntent = event => { if (event.button && event.button !== 0) return; record.moving = Boolean(event.target.closest('.noUi-connect')); if (mark) { activeId = mark.id; const focus = event.target.closest('.noUi-handle') || record.body; focus?.focus(); } };
      record.captureIntent = captureIntent;
      node.addEventListener('mousedown', captureIntent, true); node.addEventListener('touchstart', captureIntent, { capture: true, passive: true });
      record.api.on('start.frame', () => {
        if (record.disposed || record.gesture || !available() || busy) return;
        const before = record.markId ? { ...currentMark(record.markId) } : null;
        record.gesture = { before, after: null, time, moving: record.moving, cancelled: false };
        gesture = record; if (before) { activeId = before.id; jump(before.start); } draw();
      });
      record.api.on('slide.frame', (_formatted, handle, values) => {
        if (record.disposed || !available() || busy) return;
        const action = record.gesture;
        if (action?.cancelled) return;
        if (record.markId) {
          const after = normalized(record, values, handle); if (action) action.after = after;
          setValues(record, [after.start, after.end]); annotate(record, after);
          scheduleSeek(handle && !action?.moving ? count() ? points[Math.max(0, nearest(points, after.end) - 1)] : after.end : after.start);
        } else { const value = snapTime(values[0]); setValues(record, [value]); scheduleSeek(value); }
      });
      record.api.on('end.frame', () => {
        if (record.disposed || !record.gesture) return;
        const action = record.gesture; record.gesture = null; if (gesture === record) gesture = null; stopSeek();
        if (action.cancelled) { jump(action.time); draw(); return; }
        if (action.before) { if (action.after) { jump(action.after.start); void commit(action.before, action.after); } }
        else jump(Number(record.api.get(true)));
        draw();
      });
      availability(record); annotate(record, mark); return record;
    }
    function draw() {
      if (queuedPoints && !gesture && !busy && !trimController?.dragging()) { clear(); points = queuedPoints; inferredRate = constantRate(points); queuedPoints = null; }
      if (!player) player = makeSlider(playElement);
      const nextRange = Math.max(.000001, length() || 1);
      if (player.range !== nextRange && !player.gesture) { player.range = nextRange; player.api.updateOptions({ range: { min: 0, max: nextRange } }, false); }
      if (!player.gesture) setValues(player, [Math.max(0, Math.min(time, nextRange))]);
      availability(player); annotate(player);
      const ids = new Set(marks.map(item => item.id));
      for (const [id, record] of sliders) if (!ids.has(id)) { dispose(record); sliders.delete(id); }
      marks.forEach(original => {
        let record = sliders.get(original.id);
        if (!record) { const node = document.createElement('div'); node.className = 'progress-mark'; node.dataset.markId = original.id; layer.append(node); record = makeSlider(node, original); sliders.set(original.id, record); }
        const mark = pending?.id === original.id ? pending : record.gesture?.after || original;
        if (record.range !== nextRange && !record.gesture) { record.range = nextRange; record.api.updateOptions({ range: { min: 0, max: nextRange } }, false); }
        if (!record.gesture) setValues(record, [mark.start, mark.end]);
        availability(record); annotate(record, mark);
      });
      root.dataset.state = available() ? busy ? 'saving' : count() ? 'ready' : 'time' : 'loading';
      trimController?.update();
      timecodeEditor?.update();
    }
    const onKey = event => {
      if (!available() || busy || event.ctrlKey || event.metaKey || !['ArrowLeft','ArrowRight','Home','End','Escape','Delete','Backspace','Enter',' '].includes(event.key)) return;
      const node = event.target.closest('[data-mark-id]'), mark = node ? currentMark(node.dataset.markId) : null;
      if (['Enter',' '].includes(event.key) && !mark) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { if (gesture?.gesture) { gesture.gesture.cancelled = true; gesture.scope.end(); } activeId = ''; draw(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { if (mark) { const ticket = epoch; busy = true; draw(); void deleteMark(mark.id).catch(error => { if (ticket === epoch) onError(error.message); }).finally(() => { if (ticket === epoch) { busy = false; draw(); } }); } return; }
      if (mark && ['Enter',' '].includes(event.key)) { activeId = mark.id; jump(mark.start); draw(); return; }
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1);
      if (!count()) {
        const edge = event.target.closest('[data-edge]')?.dataset.edge || '';
        const value = mark ? edge === 'end' ? mark.end : mark.start : time;
        const next = clamp(event.key === 'Home' ? 0 : event.key === 'End' ? length() : value + delta * .1, 0, length());
        if (!mark) jump(next);
        else {
          const record = sliders.get(mark.id); record.gesture = { before: mark, moving: !edge };
          const after = normalized(record, edge === 'end' ? [mark.start, next] : [next, mark.end], edge === 'end' ? 1 : 0); record.gesture = null;
          activeId = mark.id; void commit(mark, after);
        }
        return;
      }
      if (mark) {
        const edge = event.target.closest('[data-edge]')?.dataset.edge || '', index = nearest(points, edge === 'end' ? mark.end : mark.start);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count() : clamp(index + delta, 0, count());
        const record = sliders.get(mark.id); let after;
        if (!edge) after = moveInterval(points, mark, points[next]);
        else { const start = clamp(nearest(points, mark.start), 0, count() - 1), end = clamp(nearest(points, mark.end), start + 1, count()); after = edge === 'start' ? { ...mark, start: points[clamp(next, 0, end - 1)] } : { ...mark, end: points[clamp(next, start + 1, count())] }; }
        activeId = mark.id; setValues(record, [after.start, after.end]); void commit(mark, after);
      } else jump(points[clamp(event.key === 'Home' ? 0 : event.key === 'End' ? count() - 1 : frameAt(points, time) + delta, 0, count() - 1)]);
    };
    track.addEventListener('keydown', onKey, true);
    const cancelPointer = () => { if (gesture?.gesture) { gesture.gesture.cancelled = true; gesture.scope.end(); } };
    track.addEventListener('pointercancel', cancelPointer, true); track.addEventListener('touchcancel', cancelPointer, true);
    const clear = () => { stopSeek(); if (player) { dispose(player); player = null; } for (const record of sliders.values()) dispose(record); sliders.clear(); gesture = null; };
    if (root.querySelector('#trim-slider')) trimController = mountTrim({ node: root.querySelector('#trim-slider'), library, model: () => ({ points, duration: length(), rate: rate(), time }), seek: jump, onChange: onTrimChange, onEnd: draw });
    timecodeEditor = mountTimecode({ node: root.querySelector('#timeline-current'), read: () => ({ value: formatTimecode(ordinal(), rate()), rate: rate(), ordinal: ordinal(), last: lastOrdinal(), enabled: editorEnabled && available() && !busy }), seekOrdinal, step: stepFrame, onError });
    return {
      ready: () => count() > 0,
      available,
      label(start, end) { if (!count()) return ''; return `第 ${nearest(points, start) + 1}–${nearest(points, end)} 帧`; },
      load(values, frameRate) { if (validRate(frameRate)) sourceRate = frameRate; queuedPoints = values; status = ''; draw(); },
      reset(message = '正在读取帧索引…') { epoch++; clear(); points = []; inferredRate = 0; queuedPoints = null; activeId = ''; pending = null; busy = false; status = message; draw(); },
      resetMedia() { sourceRate = 0; inferredRate = 0; duration = 0; time = 0; trimController?.reset(); timecodeEditor?.reset(); },
      setEditorEnabled(value) { editorEnabled = Boolean(value); timecodeEditor?.update(); },
      setRate(value) { if (validRate(value)) sourceRate = value; },
      rate,
      timecode(value, boundary = false) { const frame = count() ? boundary ? nearest(points, value) : frameAt(points, value) : Math.floor(Math.max(0, value) * rate() + 1e-6); return formatTimecode(frame, rate()); },
      seekTimecode(value) { const frame = parseTimecode(value, rate()); if (frame >= (count() || Math.ceil(length() * rate()))) throw new Error('时间码超出视频帧范围'); jump(count() ? points[frame] : frame / rate()); },
      trim: () => trimController?.value() || { start: 0, end: length() },
      setTrimPoint(edge, value) { trimController?.setPoint(edge, value); },
      setTrim(start, end) { trimController?.setRange(start, end); },
      resetTrim() { trimController?.reset(); },
      update(value, mediaDuration) { time = value; if (Number.isFinite(mediaDuration)) duration = mediaDuration; draw(); },
      marks(values) { marks = values; if (!marks.some(item => item.id === activeId)) activeId = ''; draw(); },
      selectMark(id) { activeId = id; draw(); },
      snap(value) { return count() ? points[nearest(points, value)] : value; },
      point(value, edge) { return count() ? points[frameAt(points, value) + (edge === 'out' ? 1 : 0)] : clamp(value, 0, length()); },
      defaultRange(value) { if (count()) return defaultRange(points, value); if (!available()) return null; const start = clamp(value, 0, Math.max(0, length() - (rate() ? 1 / rate() : .001))); return { start, end: Math.min(length(), start + 5) }; },
      destroy() { epoch++; clear(); trimController?.destroy(); timecodeEditor?.destroy(); track.removeEventListener('keydown', onKey, true); track.removeEventListener('pointercancel', cancelPointer, true); track.removeEventListener('touchcancel', cancelPointer, true); },
    };
  }
  return { frameAt, nearest, defaultRange, moveInterval, formatTimecode, parseTimecode, mount };
});
