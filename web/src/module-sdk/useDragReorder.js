import { useCallback, useState } from 'react';

export function useDragReorder({ onReorder }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const moveTo = useCallback((from, insertAt) => {
    if (from === insertAt || from + 1 === insertAt) return;
    const toIndex = insertAt > from ? insertAt - 1 : insertAt;
    onReorder(from, toIndex);
  }, [onReorder]);

  const handleDragStart = useCallback((e, i) => {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  }, []);

  const handleDragOver = useCallback((e, i) => {
    if (dragIndex == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const side = e.clientY < midY ? 'top' : 'bottom';
    setDropTarget(prev => {
      if (prev?.index === i && prev?.side === side) return prev;
      return { index: i, side };
    });
  }, [dragIndex]);

  const handleDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(null);
    }
  }, []);

  const handleDrop = useCallback((e, i) => {
    e.preventDefault();
    if (dragIndex == null) return;
    const insertAt = dropTarget?.side === 'bottom' ? i + 1 : i;
    moveTo(dragIndex, insertAt);
    setDragIndex(null);
    setDropTarget(null);
  }, [dragIndex, dropTarget, moveTo]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDropTarget(null);
  }, []);

  const rowProps = useCallback((i) => ({
    onDragStart: (e) => handleDragStart(e, i),
    onDragOver: (e) => handleDragOver(e, i),
    onDrop: (e) => handleDrop(e, i),
    onDragEnd: handleDragEnd,
  }), [handleDragStart, handleDragOver, handleDrop, handleDragEnd]);

  const containerProps = { onDragLeave: handleDragLeave };

  return { dragIndex, dropTarget, rowProps, containerProps };
}
