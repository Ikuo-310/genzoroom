export type CropOverlay='thirds'|'grid'|'golden'|'diagonals'|'halves'|'none';
export function cropOverlayPaths(kind:CropOverlay,w:number,h:number):string[]{
 if(![w,h].every(Number.isFinite)||w<=0||h<=0)return [];
 const line=(x1:number,y1:number,x2:number,y2:number)=>`M${x1*w} ${y1*h}L${x2*w} ${y2*h}`;
 if(kind==='none')return [];
 if(kind==='thirds')return [.333333,.666667].flatMap(v=>[line(v,0,v,1),line(0,v,1,v)]);
 if(kind==='halves')return [line(.5,0,.5,1),line(0,.5,1,.5)];
 if(kind==='golden')return [.381966,.618034].flatMap(v=>[line(v,0,v,1),line(0,v,1,v)]);
 if(kind==='diagonals')return [line(0,0,1,1),line(1,0,0,1)];
 if(kind==='grid')return Array.from({length:8},(_,i)=>(i+1)/9).flatMap(v=>[line(v,0,v,1),line(0,v,1,v)]);
 return [];
}
