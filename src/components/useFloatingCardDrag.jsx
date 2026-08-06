import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

const LONG_PRESS_MS = 700;
const DRAG_TIMEOUT_MS = 5000;

export function useFloatingCardDrag(payload) {
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [dragPoint, setDragPoint] = useState(null);

  function clearDragTimers(drag = dragRef.current) {
    if (!drag) return;
    window.clearTimeout(drag.longPressTimer);
    window.clearTimeout(drag.timeoutTimer);
  }

  function restoreDocumentStyles(drag) {
    if (!drag?.started) return;
    document.body.style.userSelect = drag.bodyUserSelect;
    document.body.style.webkitUserSelect = drag.bodyWebkitUserSelect;
    document.body.style.cursor = drag.bodyCursor;
    document.documentElement.classList.remove('floating-card-drag-active');
    document.body.classList.remove('floating-card-drag-active');
    if (drag.blockSelection) {
      document.removeEventListener('selectstart', drag.blockSelection, true);
      document.removeEventListener('dragstart', drag.blockSelection, true);
      document.removeEventListener('selectionchange', drag.blockSelection, true);
    }
    window.getSelection?.()?.removeAllRanges();
  }

  function cancelDrag(event) {
    const drag = dragRef.current;
    if (!drag) return;
    clearDragTimers(drag);
    dragRef.current = null;
    drag.element?.releasePointerCapture?.(drag.pointerId);
    if (drag.started) void window.electronAPI.floatingDragCancel?.(drag.dragId);
    restoreDocumentStyles(drag);
    setDragging(false);
    setDragPoint(null);
  }

  async function beginDrag(drag) {
    if (dragRef.current !== drag) return;
    drag.started = true;
    drag.bodyUserSelect = document.body.style.userSelect;
    drag.bodyWebkitUserSelect = document.body.style.webkitUserSelect;
    drag.bodyCursor = document.body.style.cursor;
    window.getSelection?.()?.removeAllRanges();
    document.documentElement.classList.add('floating-card-drag-active');
    document.body.classList.add('floating-card-drag-active');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    document.body.style.cursor = 'grabbing';
    const blockSelection = event => {
      event.preventDefault();
      window.getSelection?.()?.removeAllRanges();
    };
    drag.blockSelection = blockSelection;
    document.addEventListener('selectstart', blockSelection, true);
    document.addEventListener('dragstart', blockSelection, true);
    document.addEventListener('selectionchange', blockSelection, true);
    setDragging(true);
    setDragPoint({ x: drag.x, y: drag.y });
    drag.lastX = drag.x;
    drag.lastY = drag.y;
    drag.timeoutTimer = window.setTimeout(() => cancelDrag(), DRAG_TIMEOUT_MS);
    drag.dragId = `drag-${Date.now()}`;
    await window.electronAPI.floatingDragStart?.({ ...payload, dragId: drag.dragId });
    if (dragRef.current !== drag || !drag.started) {
      void window.electronAPI.floatingDragCancel?.(drag.dragId);
      return;
    }
    await window.electronAPI.floatingDragMove?.({ clientX: drag.x, clientY: drag.y });
  }

  function handlePointerDown(event) {
    if (event.button !== 0 || dragRef.current || event.target.closest?.('button, input, textarea, select, a')) return;
    const drag = { pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, started: false, longPressTimer: 0, timeoutTimer: 0, bodyUserSelect: '', bodyWebkitUserSelect: '', bodyCursor: '' };
    dragRef.current = drag;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    drag.longPressTimer = window.setTimeout(() => beginDrag(drag), LONG_PRESS_MS);
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started && (Math.abs(event.clientX - drag.x) > 8 || Math.abs(event.clientY - drag.y) > 8)) {
      event.preventDefault();
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      return;
    }
    if (drag.started) {
      event.preventDefault();
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      void window.electronAPI.floatingDragMove?.({ clientX: event.clientX, clientY: event.clientY });
      setDragPoint({ x: event.clientX, y: event.clientY });
    }
  }

  function handlePointerUp(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearDragTimers(drag);
    dragRef.current = null;
    drag.element?.releasePointerCapture?.(drag.pointerId);
    if (drag.started) void window.electronAPI.floatingDragEnd?.({ clientX: event.clientX, clientY: event.clientY, dragId: drag.dragId });
    restoreDocumentStyles(drag);
    setDragging(false);
    setDragPoint(null);
  }

  function handlePointerCancel(event) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    cancelDrag(event);
  }

  useEffect(() => {
    const onBlur = () => cancelDrag();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      cancelDrag();
    };
  }, []);

  return {
    dragging,
    dragPoint,
    dragHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
    },
  };
}

export function DragGhost({ dragging, dragPoint, label = '拖入悬浮窗' }) {
  if (!dragging) return null;
  const style = dragPoint ? { left: dragPoint.x, top: dragPoint.y } : undefined;
  const ghost = <div className="floating-card-drag-ghost" style={style} aria-live="polite"><strong>{label}</strong><span>松开载入</span></div>;
  return document.body ? createPortal(ghost, document.body) : ghost;
}
