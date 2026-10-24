import {readFileSync,writeFileSync} from 'node:fs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const favicon=readFileSync(new URL('./favicon.svg',import.meta.url),'utf8');
const template=readFileSync(new URL('./worker.template.js',import.meta.url),'utf8');
writeFileSync(new URL('./worker.js',import.meta.url),'// Generated from marketing/index.html and marketing/worker.template.js.\nconst PAGE='+JSON.stringify(html)+';\nconst FAVICON='+JSON.stringify(favicon)+';\n'+template);
