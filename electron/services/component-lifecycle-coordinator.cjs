class ComponentLifecycleCoordinator {
  constructor({ blocker = () => false, promotionTimeoutMs = 7500 } = {}) {
    this.transitions = new Map();
    this.work = new Map();
    this.workWaiters = new Map();
    this.globalQuiescing = false;
    this.applicationQuitPhase = 'idle';
    this.quitCommitted = false;
    this.startupRecovering = false;
    this.blocker = blocker;
    this.persistentBlocks = new Map();
    this.corruptTransactionState = false;
    this.promotionTimeoutMs = promotionTimeoutMs;
  }

  waitForComponentWork(componentId, { timeoutMs = this.promotionTimeoutMs } = {}) {
    const id = String(componentId || '');
    if (!this.work.get(id)?.size) return Promise.resolve();
    let timer;
    return new Promise((resolve, reject) => {
      const waiters = this.workWaiters.get(id) || new Set();
      const waiter = () => { clearTimeout(timer); waiters.delete(waiter); if (!waiters.size) this.workWaiters.delete(id); resolve(); };
      waiters.add(waiter); this.workWaiters.set(id, waiters);
      timer = setTimeout(() => { waiters.delete(waiter); if (!waiters.size) this.workWaiters.delete(id); reject(Object.assign(new Error('组件后台工作未在 transition 期限内结束'), { code: 'COMPONENT_BUSY' })); }, Math.max(1, Number(timeoutMs) || this.promotionTimeoutMs));
    });
  }

  unavailableError(componentId) {
    const id = String(componentId || '');
    if (this.startupRecovering) return Object.assign(new Error('组件持久事务仍在启动恢复中'), { code: 'COMPONENT_RECOVERY_PENDING' });
    if (this.corruptTransactionState || this.persistentBlocks.has(id)) {
      return Object.assign(new Error(`组件 ${id} 有未完成的持久事务，恢复前禁止启动`), { code: 'COMPONENT_TRANSACTION_BLOCKED' });
    }
    if (this.blocker(id)) {
      return Object.assign(new Error(`组件 ${id} 的旧进程树尚未确认清空，请重试关闭后台进程`), { code: 'COMPONENT_TERMINATION_UNCONFIRMED' });
    }
    const transition = this.transitions.get(id);
    if (this.globalQuiescing || transition) {
      return Object.assign(new Error(`组件 ${id} 正在${transition?.operation || '退出协调'}，暂不接受新工作`), { code: 'COMPONENT_QUIESCING' });
    }
    return null;
  }

  assertAvailable(componentId) {
    const error = this.unavailableError(componentId);
    if (error) throw error;
  }

  acquireWork(componentId, operation = 'component-work') {
    const id = String(componentId || '').trim();
    if (!id) throw new Error('组件 ID 不能为空');
    this.assertAvailable(id);
    let released = false;
    let references = 1;
    const releaseReference = () => {
      references -= 1;
      if (references > 0) return;
      leases.delete(lease);
      if (!leases.size) {
        this.work.delete(id);
        for (const resolve of this.workWaiters.get(id) || []) resolve();
        this.workWaiters.delete(id);
      }
    };
    const lease = {
      componentId: id,
      operation,
      token: Symbol(id),
      retain: () => {
        if (references <= 0) throw Object.assign(new Error('组件 work lease 已释放'), { code: 'COMPONENT_QUIESCING' });
        references += 1;
        let retainedReleased = false;
        return { release: () => { if (!retainedReleased) { retainedReleased = true; releaseReference(); } } };
      },
      release: () => {
        if (released) return;
        released = true;
        releaseReference();
      },
    };
    const leases = this.work.get(id) || new Set();
    leases.add(lease);
    this.work.set(id, leases);
    return lease;
  }

  acquire(componentId, operation, { stopOnly = false } = {}) {
    const id = String(componentId || '').trim();
    if (!id) throw new Error('组件 ID 不能为空');
    if (this.globalQuiescing || this.transitions.has(id) || this.persistentBlocks.has(id) || this.corruptTransactionState) throw this.unavailableError(id) || Object.assign(new Error('组件 transition 正在进行'), { code: 'COMPONENT_QUIESCING' });
    if (this.blocker(id) && !stopOnly) throw this.unavailableError(id);
    const state = { componentId: id, operation: String(operation || 'transition'), phase: 'intent', token: Symbol(id) };
    this.transitions.set(id, state);
    let released = false;
    const settled = options => this.waitForComponentWork(id, options);
    return {
      ...state,
      settled,
      requestStop: () => { state.stopRequested = true; },
      promote: async () => {
        await settled({ timeoutMs: this.promotionTimeoutMs });
        if (released || this.transitions.get(id)?.token !== state.token) throw Object.assign(new Error('组件 transition intent 已失效'), { code: 'COMPONENT_QUIESCING' });
        state.phase = 'exclusive';
      },
      release: () => {
        if (!released && this.transitions.get(id)?.token === state.token) this.transitions.delete(id);
        released = true;
      },
    };
  }

  acquireRecovery(componentId) {
    const id = String(componentId || '').trim();
    if (!id) throw new Error('组件 ID 不能为空');
    if (this.globalQuiescing || this.transitions.has(id) || this.corruptTransactionState) throw Object.assign(new Error('组件恢复与退出或其他 transition 冲突'), { code: 'COMPONENT_QUIESCING' });
    const state = { componentId: id, operation: '持久事务恢复', phase: 'intent', token: Symbol(id), recovery: true };
    this.transitions.set(id, state);
    let released = false;
    const settled = options => this.waitForComponentWork(id, options);
    return { ...state, settled, requestStop: () => { state.stopRequested = true; }, promote: async () => { await settled({ timeoutMs: this.promotionTimeoutMs }); if (released || this.transitions.get(id)?.token !== state.token) throw Object.assign(new Error('组件恢复 intent 已失效'), { code: 'COMPONENT_QUIESCING' }); state.phase = 'exclusive'; }, release: () => { if (!released && this.transitions.get(id)?.token === state.token) this.transitions.delete(id); released = true; } };
  }

  beginApplicationQuit() {
    if (this.startupRecovering || this.globalQuiescing || this.transitions.size) return false;
    this.globalQuiescing = true;
    this.applicationQuitPhase = 'intent';
    return true;
  }

  requestApplicationStop() {
    if (this.applicationQuitPhase !== 'intent') throw new Error('应用退出尚未进入 intent');
    this.applicationQuitPhase = 'stop';
  }

  commitApplicationQuit() {
    if (this.applicationQuitPhase !== 'stop') throw new Error('应用退出尚未确认停止后台工作');
    this.quitCommitted = true;
    this.applicationQuitPhase = 'committed';
  }

  cancelApplicationQuit() {
    if (!this.quitCommitted) {
      this.globalQuiescing = false;
      this.applicationQuitPhase = 'idle';
    }
  }

  isQuiescing(componentId) {
    return this.globalQuiescing || this.transitions.has(String(componentId || ''));
  }

  currentLease(componentId) {
    const leases = this.work.get(String(componentId || ''));
    return leases?.size ? [...leases][leases.size - 1] : null;
  }

  hasWork(componentId) {
    return Boolean(this.work.get(String(componentId || ''))?.size);
  }

  isActiveWorkLease(componentId, lease) {
    return Boolean(lease && this.work.get(String(componentId || ''))?.has(lease));
  }

  async waitForAllWork({ timeoutMs = 7500 } = {}) {
    const registrations = [];
    const pending = [...this.work.keys()].map(componentId => new Promise(resolve => {
      const waiters = this.workWaiters.get(componentId) || new Set();
      const waiter = () => { waiters.delete(waiter); if (!waiters.size) this.workWaiters.delete(componentId); resolve(); };
      registrations.push({ componentId, waiters, waiter }); waiters.add(waiter);
      this.workWaiters.set(componentId, waiters);
    }));
    if (!pending.length) return;
    let timer;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('组件后台工作未在退出期限内停止'), { code: 'APP_QUIT_BUSY' })), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const { componentId, waiters, waiter } of registrations) { waiters.delete(waiter); if (!waiters.size) this.workWaiters.delete(componentId); }
    }
  }

  assertLaunchAllowed(componentId, lease) {
    const id = String(componentId || '');
    if (this.startupRecovering) throw Object.assign(new Error('组件持久事务仍在启动恢复中'), { code: 'COMPONENT_RECOVERY_PENDING' });
    if (this.corruptTransactionState || this.persistentBlocks.has(id)) throw Object.assign(new Error(`组件 ${id} 有未完成的持久事务，恢复前禁止启动`), { code: 'COMPONENT_TRANSACTION_BLOCKED' });
    if (this.blocker(id)) throw Object.assign(new Error(`组件 ${id} 的旧进程树尚未确认清空，请重试关闭后台进程`), { code: 'COMPONENT_TERMINATION_UNCONFIRMED' });
    if (this.applicationQuitPhase === 'stop' || this.applicationQuitPhase === 'committed' || this.transitions.get(id)?.stopRequested === true) throw Object.assign(new Error('组件停止已确认，禁止启动新的组件进程'), { code: 'COMPONENT_QUIESCING' });
    const validWorkLease = lease?.componentId === id && this.isActiveWorkLease(id, lease);
    if (validWorkLease) return;
    if (this.globalQuiescing) throw Object.assign(new Error('应用正在退出，禁止启动新的组件进程'), { code: 'COMPONENT_QUIESCING' });
    this.assertAvailable(id);
  }

  blockPersistent(componentId, error) {
    this.persistentBlocks.set(String(componentId || ''), error?.message || String(error || 'blocked'));
  }

  unblockPersistent(componentId) {
    this.persistentBlocks.delete(String(componentId || ''));
  }

  blockForCorruptTransaction() {
    this.corruptTransactionState = true;
  }

  beginStartupRecovery() {
    this.startupRecovering = true;
  }

  completeStartupRecovery() {
    this.startupRecovering = false;
  }
}

module.exports = { ComponentLifecycleCoordinator };
