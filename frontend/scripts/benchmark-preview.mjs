// Run from frontend: node scripts/benchmark-preview.mjs <baseline-ref>
// Synthetic pixels only; excludes browser decode, Canvas, React and RAF.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { strict as assert } from 'node:assert';
import { cpus } from 'node:os';
const ref = process.argv[2];
if (!ref || ref.startsWith('-')) throw new Error('Supply baseline git ref');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const revision = git('rev-parse', '--verify', ref).trim();
const historical = name => git('show', revision + ':frontend/src/' + name);
const plain = source => stripTypeScriptTypes(source).replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const compile = (editing, pipeline) => new Function(plain(editing) + '\n' + plain(pipeline) + ';return {renderAdjustments,defaultRecipe};')();
const filename = 'adjustmentPipeline.ts';
const historicalName = git('ls-tree', '--name-only', revision, 'src/adjustmentPipeline.ts').trim() ? 'adjustmentPipeline.ts' : 'exposurePipeline.ts';
const before = compile(historical('editing.ts'), historical(historicalName));
const after = compile(readFileSync('src/editing.ts', 'utf8'), readFileSync('src/' + filename, 'utf8'));
const basic = { exposure: .5, contrast: 20, highlights: -30, whites: 25, shadows: 40, blacks: -20 };
const cases = {
 A_default: {}, B_basic: basic, C_WB_basic: {...basic, temperature:-25,tint:15},
 D_shadowsTemperature: {shadowsTemperature:-60}, E_shadowsTint:{shadowsTint:45},
 F_shadowsBoth:{shadowsTemperature:-60,shadowsTint:45},
 G_all:{...basic,temperature:-25,tint:15,shadowsTemperature:-60,shadowsTint:45,vibrance:25,saturation:15}
};
const recipe = values => { const r = after.defaultRecipe(); Object.assign(r.adjustments,values); return r; };
const median = v => v.sort((a,b)=>a-b)[Math.floor(v.length/2)];
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,revision,warmup:3,samples:7,seed:17}));
for (const [width,height] of [[1920,1080],[2560,1440]]) {
 const source = new Uint8ClampedArray(width*height*4);
 let seed=17;
 for(let i=0;i<source.length;i+=4) {
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  source.set([seed&255,(seed>>>8)&255,(seed>>>16)&255,seed>>>24],i);
 }
 for(const [name,values] of Object.entries(cases)) {
  const r=recipe(values);
  assert.deepEqual(after.renderAdjustments(source,r),before.renderAdjustments(source,r));
  for(let i=0;i<3;i++){before.renderAdjustments(source,r);after.renderAdjustments(source,r);}
  const timings=[[],[]];
  for(let s=0;s<7;s++) for(const j of s%2?[1,0]:[0,1]) {
   const start=performance.now(); const result=[before,after][j].renderAdjustments(source,r);
   timings[j].push(performance.now()-start); assert.equal(result.length,source.length);
  }
  const beforeMs=median(timings[0]),afterMs=median(timings[1]);
  console.log(JSON.stringify({width,height,name,beforeMs:+beforeMs.toFixed(2),afterMs:+afterMs.toFixed(2),reductionPercent:+(100*(1-afterMs/beforeMs)).toFixed(1)}));
 }
}
// Broad deterministic comparisons, including both sides of grading thresholds.
const samples=[];
for(let r=0;r<256;r++) for(let b=0;b<256;b++){
 for(let g=0;g<256;g+=16) samples.push(r,g,b,(r+g+b)&255);
 samples.push(r,255,b,r^b);
 for(const y of [.15,.35]){
  const boundary=(255*y-.2126*r-.0722*b)/.7152;
  for(const g of [Math.floor(boundary),Math.ceil(boundary)])
   if(g>=0&&g<=255) samples.push(r,g,b,(r+b)&255);
 }
}
for(let v=0;v<256;v++) samples.push(v,v,v,v);
const source=new Uint8ClampedArray(samples);
const checks=[...Object.values(cases)];
for(const t of [-100,-1,0,1,100]) for(const tint of [-100,-1,0,1,100])
 checks.push({shadowsTemperature:t,shadowsTint:tint});
checks.push({...basic,temperature:100,tint:-100,shadowsTemperature:100,shadowsTint:-100,vibrance:-100,saturation:100});
for(const values of checks){
 const r=recipe(values);
 assert.deepEqual(after.renderAdjustments(source,r),before.renderAdjustments(source,r));
}
console.log(JSON.stringify({compatibilityPixels:source.length/4,recipes:checks.length,byteIdentical:true}));
