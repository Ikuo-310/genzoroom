export type CropOverlay='thirds'|'grid'|'golden'|'diagonals'|'halves'|'spiral'|'none';
export function cropOverlayPaths(kind:CropOverlay,w:number,h:number,direction=0):string[]{
 if(![w,h,direction].every(Number.isFinite)||w<=0||h<=0)return [];
 const line=(x1:number,y1:number,x2:number,y2:number)=>`M${x1*w} ${y1*h}L${x2*w} ${y2*h}`;
 if(kind==='none')return [];
 if(kind==='thirds')return [.333333,.666667].flatMap(v=>[line(v,0,v,1),line(0,v,1,v)]);
 if(kind==='halves')return [line(.5,0,.5,1),line(0,.5,1,.5)];
 if(kind==='golden')return [.381966,.618034].flatMap(v=>[line(v,0,v,1),line(0,v,1,v)]);
 if(kind==='diagonals')return [line(0,0,1,1),line(1,0,0,1)];
 if(kind==='grid')return Array.from({length:8},(_,i)=>(i+1)/9).flatMap(v=>[line(v,0,v,1),line(0,v,1,v)]);
 // Draw a golden-ratio polyline in normalized crop coordinates; rotate normalized
 // points before scaling so portrait and landscape frames retain the same geometry.
 const points:{x:number;y:number}[]=[];for(let i=0;i<=120;i++){const t=i/120,theta=t*Math.PI*2,r=.5*Math.pow(1/1.61803398875,t*4);points.push({x:.5+r*Math.cos(theta),y:.5+r*Math.sin(theta)});}
 const turns=((Math.round(direction/90)%4)+4)%4;
 return [points.map((p,i)=>{let x=p.x,y=p.y;for(let n=0;n<turns;n++)[x,y]=[1-y,x];return `${i?'L':'M'}${x*w} ${y*h}`;}).join('')];
}
