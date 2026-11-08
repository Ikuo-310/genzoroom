import type { Point } from './viewerMath';
import { viewerPointLoupePosition, VIEWER_POINT_LOUPE_MAGNIFICATION, VIEWER_POINT_LOUPE_SIZE } from './viewerPointLoupeMath';
import type { RawRegionLayer } from './rawRegionOverlay';

type ViewerPointLoupeProps = {
  viewport: Point;
  anchor: Point;
  imagePoint: Point;
  imageSize: Point;
  scale: number;
  source: string;
  region?: RawRegionLayer;
  fixed?: boolean;
  showCursorCrosshair?: boolean;
};

export function ViewerPointLoupe({ viewport, anchor, imagePoint, imageSize, scale, source, region,
  fixed = false, showCursorCrosshair = true }: ViewerPointLoupeProps) {
  const position = viewerPointLoupePosition(viewport, anchor);
  if (!position || !source || imageSize.x <= 0 || imageSize.y <= 0 || scale <= 0) return null;
  const zoom = VIEWER_POINT_LOUPE_MAGNIFICATION;
  const size = VIEWER_POINT_LOUPE_SIZE;
  const displayedWidth = imageSize.x * scale * zoom;
  const displayedHeight = imageSize.y * scale * zoom;
  const imageLeft = size / 2 - imagePoint.x * displayedWidth;
  const imageTop = size / 2 - imagePoint.y * displayedHeight;
  return <>
    {showCursorCrosshair && <span className="viewer-point-crosshair" aria-hidden="true"
      style={{ left: anchor.x, top: anchor.y, pointerEvents: 'none' }} />}
    <div className="viewer-point-loupe" data-testid="viewer-point-loupe" data-fixed={fixed} data-point-x={imagePoint.x} data-point-y={imagePoint.y}
      aria-hidden="true" style={{ left: position.x, top: position.y, width: size, height: size, pointerEvents: 'none' }}>
      <div className="viewer-point-loupe-image" style={{ left: imageLeft, top: imageTop, width: displayedWidth, height: displayedHeight }}>
        <img src={source} alt="" draggable="false" />
        {region && <img className="viewer-point-loupe-region" src={region.url} alt="" draggable="false"
          style={{ left: region.nativePlacement.x0 * scale * zoom, top: region.nativePlacement.y0 * scale * zoom,
            width: (region.nativePlacement.x1 - region.nativePlacement.x0) * scale * zoom,
            height: (region.nativePlacement.y1 - region.nativePlacement.y0) * scale * zoom,
            clipPath: `inset(${(region.validNativeRect.y0 - region.nativePlacement.y0) * scale * zoom}px ${(region.nativePlacement.x1 - region.validNativeRect.x1) * scale * zoom}px ${(region.nativePlacement.y1 - region.validNativeRect.y1) * scale * zoom}px ${(region.validNativeRect.x0 - region.nativePlacement.x0) * scale * zoom}px)` }} />}
      </div>
      <span className="viewer-point-loupe-crosshair" />
    </div>
  </>;
}
