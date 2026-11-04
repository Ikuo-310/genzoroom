import { describe,it,expect } from 'vitest';
import { straightenFromLine } from './rawStraightenTool';
describe('straightenFromLine',()=>{
 it.each([[5,0,-5],[-5,0,5],[85,0,5],[95,0,-5],[185,0,-5],[275,0,-5],[45,0,45],[-45,0,45]])('levels a %s degree visible line from current %s to %s', (degrees,current,expected)=>{
  const r=degrees*Math.PI/180;expect(straightenFromLine({x:0,y:0},{x:100*Math.cos(r),y:100*Math.sin(r)},current)).toBe(expected);
 });
 it('uses current straighten as baseline, clamps and rounds',()=>{
  expect(straightenFromLine({x:0,y:0},{x:100,y:9},4)).toBe(-1.1);
  expect(straightenFromLine({x:0,y:0},{x:100,y:20},45)).toBe(33.7);
 });
 it('is direction independent and rejects short/nonfinite lines',()=>{
  expect(straightenFromLine({x:0,y:0},{x:100,y:9},0)).toBe(straightenFromLine({x:100,y:9},{x:0,y:0},0));
  expect(straightenFromLine({x:0,y:0},{x:1,y:1},0)).toBeNull();expect(straightenFromLine({x:NaN,y:0},{x:2,y:3},0)).toBeNull();
 });
});


