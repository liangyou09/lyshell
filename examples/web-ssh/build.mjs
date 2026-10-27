import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
const here=dirname(fileURLToPath(import.meta.url))
const require=createRequire(join(here,'package.json'))
const Zip=require('adm-zip')
await build({entryPoints:[join(here,'src/main.ts'),join(here,'src/standalone.ts')],outdir:here,bundle:true,platform:'node',target:'node20',format:'cjs',external:['cpu-features','./crypto/build/Release/sshcrypto.node','bufferutil','utf-8-validate'],legalComments:'eof'})
await build({entryPoints:[join(here,'web/terminal.ts')],outfile:join(here,'web/terminal.js'),bundle:true,platform:'browser',target:'es2022',format:'iife',legalComments:'eof'})
await copyFile(require.resolve('@xterm/xterm/css/xterm.css'),join(here,'web/xterm.css'))
const licenses=[]
for(const name of ['ssh2','ws','asn1','bcrypt-pbkdf','tweetnacl','safer-buffer','@xterm/xterm','@xterm/addon-fit']){
  const root=dirname(require.resolve(name+'/package.json'))
  let license
  for(const file of ['LICENSE','LICENSE.txt','LICENSE.md']){try{license=await readFile(join(root,file),'utf8');break}catch{/* Try the package's next common license filename. */}}
  if(!license)throw Error('Missing license: '+name)
  licenses.push(`\n--- ${name} ---\n${license}`)
}
await writeFile(join(here,'THIRD_PARTY_LICENSES.txt'),licenses.join('\n'),'utf8')
const zip=new Zip()
for(const file of ['lyshell-plugin.json','main.js','standalone.js','icon.svg','README.md','THIRD_PARTY_LICENSES.txt'])zip.addLocalFile(join(here,file))
for(const file of ['index.html','terminal.js','terminal.css','xterm.css'])zip.addLocalFile(join(here,'web',file),'web')
for(const file of ['launcher.html','launcher.js','launcher.css'])zip.addLocalFile(join(here,'views',file),'views')
zip.addFile('views/runtime.json',Buffer.from('{"port":null}\n'))
await mkdir(join(here,'dist'),{recursive:true})
const output=join(here,'dist/web-ssh-0.1.0.zip')
zip.writeZip(output)
console.log(output)
