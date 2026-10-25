// Execute the production C0 TypeScript planner for Native integration probes, without a second planner port.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { stripTypeScriptTypes } = require('node:module');
if (typeof stripTypeScriptTypes !== 'function') throw new Error('C0 probe requires Node with stripTypeScriptTypes (verified on Node 24.19)');
const sourcePath = path.join(root, 'frontend/src/rawRegionPlanner.ts');
const contract = fs.readFileSync(path.join(root, 'frontend/src/rawRegionContract.json'), 'utf8');
const source = fs.readFileSync(sourcePath, 'utf8').replace("import contract from './rawRegionContract.json';", `const contract = ${contract};`);
if (source.includes("import contract from")) throw new Error('planner JSON import was not resolved');
const compiled = stripTypeScriptTypes(source);
import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`).then(planner => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(planner.planRawRegion(input)));
}).catch(() => { console.error('C0 planner probe failed'); process.exitCode = 1; });
