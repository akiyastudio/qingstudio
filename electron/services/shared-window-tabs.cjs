const { randomUUID } = require('node:crypto');

// One application renderer per window. Ordinary tabs are React state in that
// renderer; only a cross-window transfer creates or contacts another renderer.
class SharedWindowTabs {
  constructor(manager, { transferComponent = () => undefined, pageComponents = () => [] } = {}) {
    this.manager = manager;
    this.transferComponent = transferComponent;
    this.pageComponents = pageComponents;
    this.requests = new Map();
    this.transfers = new Set();
  }
  publish(host, tabs) {
    if (!Array.isArray(tabs) || tabs.length > 48 || Buffer.byteLength(JSON.stringify(tabs)) > 65536) throw new Error('无效的窗口标签列表');
    const ids = new Set();
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== 'string' || !tab.id || tab.id.length > 512 || ids.has(tab.id)
        || typeof tab.label !== 'string' || tab.label.length > 512 || !['home', 'project', 'inspiration', 'component', 'version', 'settings', 'search-all'].includes(tab.kind)
        || typeof tab.active !== 'boolean' || typeof tab.pinned !== 'boolean') throw new Error('无效的窗口标签');
      if (tab.pinned && (tab.kind !== 'home' || !host.root)) throw new Error('无效的固定标签');
      ids.add(tab.id);
    }
    host.localTabs = structuredClone(tabs);
    this.manager.publish();
  }
  request(host, action, payload = {}) {
    if (host.closed || host.isDestroyed()) return Promise.reject(new Error('窗口已关闭'));
    const token = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(token); reject(new Error('窗口未能完成标签页交接，请重试')); }, 30000);
      this.requests.set(token, { host, resolve, reject, timer });
      try { host.webContents.send('workspace-windows:tab-request', { token, action, ...payload }); }
      catch (error) { clearTimeout(timer); this.requests.delete(token); reject(error); }
    });
  }
  respond(host, token, result, error) {
    const pending = this.requests.get(token);
    if (!pending || pending.host !== host) return false;
    clearTimeout(pending.timer); this.requests.delete(token);
    if (error) pending.reject(new Error(String(error).slice(0, 512))); else pending.resolve(result);
    return true;
  }
  dispose(host) {
    for (const [token, pending] of this.requests) if (pending.host === host) {
      clearTimeout(pending.timer); this.requests.delete(token); pending.reject(new Error('窗口已关闭'));
    }
  }
  owned(host, id) {
    const tab = host.localTabs?.find(tab => tab.id === id);
    if (!tab || tab.pinned) throw new Error('此标签页不能移出窗口');
    return tab;
  }
  async open(host, seed) { return this.request(host, 'open', { seed }); }
  async transfer(source, id, destination = null, bounds) {
    this.owned(source, id);
    if (source === destination) return;
    if (this.transfers.has(source.id) || destination && this.transfers.has(destination.id)) throw new Error('窗口正在交接标签页，请稍后再试');
    const manager = this.manager;
    const sourceRecord = manager.windows.get(source.nativeWindow.id);
    const destinationRecord = destination && manager.windows.get(destination.nativeWindow.id);
    if (!sourceRecord || sourceRecord.pendingClose || sourceRecord.closing || destination && (!destinationRecord || destinationRecord.pendingClose || destinationRecord.closing)) throw new Error('窗口正在关闭，请稍后再移动');
    this.transfers.add(source.id); sourceRecord.transferring = true;
    if (destination) { this.transfers.add(destination.id); destinationRecord.transferring = true; }
    let seed, target = destination, created = false, imported = false, targetTabId;
    const movedComponents = [];
    try {
      seed = manager.validateSeed(await this.request(source, 'export', { id }));
      const componentIds = [...new Set([seed.transfer?.componentPage?.instanceId, ...this.pageComponents(source, seed.page?.id)].filter(Boolean))];
      const moveComponents = host => { for (const id of componentIds) { this.transferComponent(id, source, host); movedComponents.push(id); } };
      if (!target) {
        const hostId = await manager.open(source, seed, { reuse: false, activate: false, onCreated: host => {
          target = host; created = true;
          moveComponents(target);
        } });
        target = manager.tabs.get(hostId);
        targetTabId = target.localTabs?.find(tab => tab.active)?.id;
        imported = true;
      } else {
        moveComponents(target);
        targetTabId = await this.request(target, 'import', { seed });
        imported = true;
      }
      if (!target || target.closed || target.isDestroyed()) throw new Error('目标窗口已关闭');
      if (!manager.canMutate()) throw new Error('软件正在退出，已取消标签页移动');
      if (created) {
        // The source renderer is frozen, but the low-level move must be allowed
        // to finish this transaction's newly-created window.
        sourceRecord.transferring = false;
        if (bounds) {
          const record = manager.registerWindow(manager.createWindow(bounds));
          try { await manager.move(target, record); } catch (error) { record.closing = true; record.window.close(); throw error; }
        } else await manager.detach(target);
        sourceRecord.transferring = true;
        manager.windows.get(target.nativeWindow.id).transferring = true;
      }
      await this.request(source, 'release', { id });
      target.nativeWindow.show(); target.nativeWindow.focus();
      if (!source.root && !source.localTabs?.length) {
        sourceRecord.closing = true; source.nativeWindow.close();
      }
    } catch (error) {
      for (const id of movedComponents.reverse()) try { this.transferComponent(id, target, source); } catch (rollbackError) { manager.writeLog('error', 'Component transfer rollback failed', { error: rollbackError.message }); }
      if (created && target) {
        const record = manager.windows.get(target.nativeWindow.id);
        manager.dispose(target);
        if (record && !record.primary && !record.ids.length) { record.closing = true; record.window.close(); }
      } else if (imported && targetTabId) await this.request(target, 'release', { id: targetTabId }).catch(() => undefined);
      await this.request(source, 'rollback', { id }).catch(() => undefined);
      throw error;
    } finally {
      this.transfers.delete(source.id); sourceRecord.transferring = false;
      if (destination) { this.transfers.delete(destination.id); destinationRecord.transferring = false; }
      if (created && target) { const record = manager.windows.get(target.nativeWindow.id); if (record) record.transferring = false; }
      manager.publish();
    }
  }
  async drop(source, id) {
    this.owned(source, id);
    const manager = this.manager, point = manager.screen.getCursorScreenPoint();
    const record = [...manager.windows.values()].filter(record => record.window.isVisible() && !record.window.isMinimized())
      .sort((a, b) => b.order - a.order).find(record => {
        const bounds = record.window.getContentBounds();
        return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
      });
    if (record?.window === source.nativeWindow) return { moved: false };
    if (record) {
      if (point.y - record.window.getContentBounds().y > 48) return { moved: false };
      await this.transfer(source, id, manager.tabs.get(record.activeId));
    } else {
      const area = manager.screen.getDisplayNearestPoint(point).workArea;
      const width = Math.min(1280, area.width), height = Math.min(800, area.height);
      await this.transfer(source, id, null, { width, height, x: Math.max(area.x, Math.min(point.x - 100, area.x + area.width - width)), y: Math.max(area.y, Math.min(point.y - 20, area.y + area.height - height)) });
    }
    return { moved: true };
  }
  async merge(destination) {
    for (const source of [...this.manager.tabs.values()]) if (source !== destination) {
      for (const tab of [...(source.localTabs || [])]) if (!tab.pinned) await this.transfer(source, tab.id, destination);
    }
  }
}
module.exports = { SharedWindowTabs };
