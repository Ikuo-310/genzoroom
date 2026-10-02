import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { clampResizedSidebar, fitSidebarWidths, readSidebarWidths, saveSidebarWidths, type SidebarSide } from './sidebarSizing';

type WorkspaceLayoutProps = {
  leftOpen: boolean;
  rightOpen: boolean;
  viewerFocusMode?: boolean;
  leftPanel: ReactNode;
  viewer: ReactNode;
  rightPanel: ReactNode;
  filmstrip: ReactNode;
};

export function WorkspaceLayout({ leftOpen, rightOpen, viewerFocusMode = false, leftPanel, viewer, rightPanel, filmstrip }: WorkspaceLayoutProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState(readSidebarWidths);
  const widthsRef = useRef(widths);
  const [containerWidth, setContainerWidth] = useState(0);
  const layoutClass = `workspace-body${leftOpen ? ' left-open' : ''}${rightOpen ? ' right-open' : ''}${viewerFocusMode ? ' viewer-focus-mode' : ''}`;
  const fitted = fitSidebarWidths(widths, containerWidth, leftOpen, rightOpen);
  const style = {
    '--left-panel-width': `${fitted.left}px`,
    '--right-panel-width': `${fitted.right}px`,
  } as CSSProperties;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const updateWidth = () => setContainerWidth(body.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  function resize(side: SidebarSide, proposedWidth: number) {
    const bodyWidth = bodyRef.current?.clientWidth ?? containerWidth;
    const current = fitSidebarWidths(widthsRef.current, bodyWidth, leftOpen, rightOpen);
    const otherSide = side === 'left' ? 'right' : 'left';
    const otherOpen = side === 'left' ? rightOpen : leftOpen;
    const width = clampResizedSidebar(side, proposedWidth, bodyWidth, current[otherSide], otherOpen);
    const next = { ...widthsRef.current, [side]: width };
    widthsRef.current = next;
    setWidths(next);
  }

  return <div ref={bodyRef} className={layoutClass} style={style}>
    <aside className="workspace-side-panel left-panel" hidden={!leftOpen}>{leftPanel}</aside>
    <SidebarResizeHandle side="left" width={fitted.left} label={t('workspace.resizeLeftPanel')}
      hidden={!leftOpen} onResize={resize} onResizeEnd={() => saveSidebarWidths(widthsRef.current)} />
    {viewer}
    <SidebarResizeHandle side="right" width={fitted.right} label={t('workspace.resizeRightPanel')}
      hidden={!rightOpen} onResize={resize} onResizeEnd={() => saveSidebarWidths(widthsRef.current)} />
    <aside className="workspace-side-panel right-panel" hidden={!rightOpen}>{rightPanel}</aside>
    {filmstrip}
  </div>;
}
