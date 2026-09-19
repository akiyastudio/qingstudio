import React, { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentHostAction, ComponentPageOpenScope } from '../../types';
import { ComponentIcon } from '../../components/ComponentIcon';
import { cleanViewportSubmenuClassName, createDelayedCloseController, positionViewportSubmenu } from './project-workspace-layout-model';

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
type CloneableElementProps = { [key: string]: unknown; children?: React.ReactNode; className?: string };

const withMenuItemRoles = (children: React.ReactNode): React.ReactNode => Children.map(children, child => {
  if (!isValidElement<CloneableElementProps>(child)) return child;
  const nested = child.props.children ? withMenuItemRoles(child.props.children) : child.props.children;
  return cloneElement(child, child.type === 'button' ? { role: 'menuitem', children: nested } : { children: nested });
});

export const ViewportSubmenu = ({ children }: { children: React.ReactNode }) => {
  const generatedId = useId().replace(/:/g, '');
  const triggerId = `viewport-submenu-trigger-${generatedId}`;
  const menuId = `viewport-submenu-${generatedId}`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement>(null);
  const closeControllerRef = useRef<ReturnType<typeof createDelayedCloseController> | null>(null);
  if (!closeControllerRef.current) closeControllerRef.current = createDelayedCloseController(() => setOpen(false));
  const openNow = () => { closeControllerRef.current?.cancelClose(); setOpen(true); };
  const closeNow = () => { closeControllerRef.current?.cancelClose(); setOpen(false); };
  useEffect(() => () => closeControllerRef.current?.dispose(), []);
  const [label, menuContent] = Children.toArray(children) as [React.ReactElement<CloneableElementProps>, React.ReactElement<CloneableElementProps>];
  const openAndFocus = () => {
    openNow();
    window.requestAnimationFrame(() => document.getElementById(menuId)?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus());
  };
  const trigger = cloneElement(label, {
    id: triggerId, ref: triggerRef, 'aria-controls': menuId, 'aria-haspopup': 'menu', 'aria-expanded': open,
    onMouseEnter: openNow, onFocus: openNow, onClick: () => { closeControllerRef.current?.cancelClose(); setOpen(value => !value); },
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openAndFocus(); } },
  });
  return <div className="group/submenu relative" onMouseEnter={openNow} onMouseLeave={() => closeControllerRef.current?.scheduleClose()} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeNow(); }}>
    {trigger}
    {cloneElement(menuContent, { id: menuId, role: 'menu', 'aria-labelledby': triggerId, 'aria-hidden': !open, className: `${open ? 'visible opacity-100' : 'invisible opacity-0'} fixed z-[302] ${cleanViewportSubmenuClassName(menuContent.props.className)}`, onMouseEnter: openNow, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeNow(); triggerRef.current?.focus(); } }, children: withMenuItemRoles(menuContent.props.children) })}
  </div>;
};

export const ComponentToolbarActions = ({ actions, scope, onOpen, overflow = false }: { actions: ComponentHostAction[]; scope: ComponentPageOpenScope; onOpen: (action: ComponentHostAction, scope: ComponentPageOpenScope) => void; overflow?: boolean }) => actions.length ? <>{!overflow && <span aria-hidden className="toolbar-divider"/>}<div aria-label="UI 组件" className={overflow ? 'component-toolbar-actions-overflow' : 'component-toolbar-actions flex shrink-0 items-center gap-1'}>{actions.map(action => <button key={`${action.componentId}:${action.actionId}`} type="button" role={overflow ? 'menuitem' : undefined} onClick={() => onOpen(action, scope)} title={action.label} className={overflow ? 'project-menu-item' : 'project-action-button'}><ComponentIcon src={action.iconUrl} size={16}/><span>{action.label}</span></button>)}</div></> : null;

export const ViewportContextMenu = ({ x, y, widthClass, allowSubmenus = false, children }: { x: number; y: number; widthClass: string; allowSubmenus?: boolean; children: React.ReactNode }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  const updatePosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const availableHeight = Math.max(0, window.innerHeight - CONTEXT_MENU_VIEWPORT_MARGIN * 2);
    const width = menu.getBoundingClientRect().width;
    const height = Math.min(menu.scrollHeight, availableHeight);
    const left = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - CONTEXT_MENU_VIEWPORT_MARGIN));
    const top = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - CONTEXT_MENU_VIEWPORT_MARGIN));
    for (const group of menu.querySelectorAll<HTMLElement>('[class*="group/submenu"]')) {
      const submenu = group.querySelector<HTMLElement>(':scope > div');
      if (!submenu) continue;
      const triggerRect = group.getBoundingClientRect();
      const submenuWidth = Math.max(submenu.offsetWidth, 208);
      const submenuHeight = Math.min(submenu.scrollHeight, availableHeight);
      const submenuPosition = positionViewportSubmenu(triggerRect, { width: submenuWidth, height: submenuHeight }, { width: window.innerWidth, height: window.innerHeight, margin: CONTEXT_MENU_VIEWPORT_MARGIN });
      const trigger = group.querySelector<HTMLElement>(':scope > button');
      trigger?.setAttribute('aria-haspopup', 'menu');
      if (!trigger?.hasAttribute('aria-expanded')) trigger?.setAttribute('aria-expanded', 'false');
      submenu.setAttribute('role', 'menu');
      if (!submenu.hasAttribute('aria-hidden')) submenu.setAttribute('aria-hidden', 'true');
      for (const item of submenu.querySelectorAll<HTMLElement>('button')) item.setAttribute('role', 'menuitem');
      submenu.style.position = 'fixed';
      submenu.style.left = `${submenuPosition.left}px`;
      submenu.style.right = 'auto';
      submenu.style.top = `${submenuPosition.top}px`;
      submenu.style.margin = '0';
      submenu.style.maxHeight = `${availableHeight}px`;
      submenu.style.overflowY = 'auto';
    }
    setPosition(current => current.left === left && current.top === top && current.ready ? current : { left, top, ready: true });
  }, [x, y]);

  useLayoutEffect(() => {
    updatePosition();
    const menu = menuRef.current;
    const resizeObserver = menu && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : null;
    if (menu) resizeObserver?.observe(menu);
    window.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('resize', updatePosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  useLayoutEffect(() => {
    if (!position.ready) return;
    const frame = window.requestAnimationFrame(updatePosition);
    const menu = menuRef.current;
    menu?.addEventListener('scroll', updatePosition, { passive: true });
    return () => { window.cancelAnimationFrame(frame); menu?.removeEventListener('scroll', updatePosition); };
  }, [position.left, position.ready, position.top, updatePosition]);

  useEffect(() => {
    if (!position.ready) return;
    const firstVisible = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[role="menuitem"]') || []).find(item => item.offsetParent !== null);
    firstVisible?.focus({ preventScroll: true });
  }, [position.ready]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const visible = (item: HTMLElement) => {
      const style = window.getComputedStyle(item);
      return item.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden' && !item.closest('[aria-hidden="true"]');
    };
    const items = Array.from(menu.querySelectorAll<HTMLElement>('button:not([disabled]),[role="menuitem"]:not([aria-disabled="true"])')).filter(visible);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const activeItem = document.activeElement as HTMLElement | null;
    const activeSubmenu = activeItem?.parentElement?.closest<HTMLElement>('[class*="group/submenu"] > div');
    if ((event.key === 'ArrowLeft' || event.key === 'Escape') && activeSubmenu) {
      event.preventDefault(); event.stopPropagation();
      delete activeSubmenu.dataset.keyboardOpen; activeSubmenu.setAttribute('aria-hidden', 'true');
      activeSubmenu.style.visibility = ''; activeSubmenu.style.opacity = '';
      const parentItem = activeSubmenu.parentElement?.querySelector<HTMLElement>(':scope > button');
      parentItem?.setAttribute('aria-expanded', 'false'); parentItem?.focus();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new Event('photoflow-menu-open')); return; }
    if (event.key === 'ArrowRight' && activeItem) {
      const submenu = activeItem.parentElement?.querySelector<HTMLElement>(':scope > div');
      const firstChild = submenu && Array.from(submenu.querySelectorAll<HTMLElement>('button:not([disabled]),[role="menuitem"]'))[0];
      if (submenu && firstChild) {
        event.preventDefault();
        submenu.dataset.keyboardOpen = 'true'; submenu.setAttribute('aria-hidden', 'false');
        activeItem.setAttribute('aria-expanded', 'true');
        submenu.style.visibility = 'visible'; submenu.style.opacity = '1'; firstChild.focus();
        return;
      }
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };

  return <div ref={menuRef} role="menu" data-fixed-submenus={allowSubmenus ? 'true' : undefined} tabIndex={-1} onKeyDown={handleKeyDown} className={`project-context-menu fixed z-[301] max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white p-1 shadow-xl ${widthClass}`} style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}>{children}</div>;
};

export const ColumnResizeHandle = ({ onDrag, label }: { onDrag: (deltaX: number) => void; label: string }) => {
  const cleanupRef = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanupRef.current(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let previousX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - previousX;
      previousX = moveEvent.clientX;
      onDrag(deltaX);
    };
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      cleanupRef.current = () => undefined;
    };
    cleanupRef.current();
    cleanupRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onDrag(event.key === 'ArrowLeft' ? -16 : 16);
  };
  return <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className="column-resize-handle"/>;
};

export const FileListColumnResizeHandle = ({ onDrag, label, last = false }: { onDrag: (deltaX: number) => void; label: string; last?: boolean }) => {
  const cleanupRef = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanupRef.current(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => onDrag(moveEvent.clientX - startX);
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      cleanupRef.current = () => undefined;
    };
    cleanupRef.current();
    cleanupRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    onDrag(event.key === 'ArrowLeft' ? -16 : 16);
  };
  return <button type="button" role="separator" aria-orientation="vertical" aria-label={label} title={label} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className={`file-list-column-resize-handle ${last ? 'is-last' : ''}`}/>;
};
