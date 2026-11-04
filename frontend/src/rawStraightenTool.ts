import type { Point } from './viewerMath';

export function straightenFromLine(start:Point,end:Point,current:number,minLength=12):number|null{
  const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy);
  if(![start.x,start.y,end.x,end.y,current,length].every(Number.isFinite)||length<minLength||Math.abs(current)>45)return null;
  // The visible line already includes orientation, flips and current straighten.
  // Select the nearest horizontal/vertical axis; an exact 45° tie selects horizontal.
  const angle=Math.atan2(dy,dx)*180/Math.PI;
  const residual=((angle+45)%90+90)%90-45;
  return Math.round(Math.max(-45,Math.min(45,current-residual))*10)/10;
}
