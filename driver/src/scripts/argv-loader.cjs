// @ts-check
// Runs a container script that arrives as argv chunks (container-scripts.ts `nodeEvalArgv`): Linux refuses any one argv
// string above 128 KiB, and the supervisor is larger. Under `node -e` this joins the chunks, gives the script the argv a
// plain `node -e` would (node alone), and runs it in the same global scope, `require` and `module` included.
'use strict';
require('node:vm').runInThisContext(process.argv.splice(1).join(''), { filename: '[eval]' });
