/** Compares byte buffers directly, without Canvas color conversion or premultiplication. */
export function compareRgba(cpu: Uint8ClampedArray, gpu: Uint8ClampedArray) {
  if (cpu.length !== gpu.length || cpu.length % 4 !== 0) throw new Error('RGBA buffer lengths do not match');
  let maximumDifference = 0;
  let differingChannels = 0;
  let alphaMatches = true;
  for (let i = 0; i < cpu.length; i++) {
    const difference = Math.abs(cpu[i] - gpu[i]);
    maximumDifference = Math.max(maximumDifference, difference);
    if (difference) {
      differingChannels++;
      if (i % 4 === 3) alphaMatches = false;
    }
  }
  return { maximumDifference, differingChannels, alphaMatches };
}
