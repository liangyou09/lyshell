import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { isWebTerminalText } from '../../../src/shared/web-terminal'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id)
const status = el('status'), notice = el('notice'), form = el<HTMLFormElement>('connect-form')
const term = new Terminal({cursorBlink:false,fontSize:14,fontFamily:'Consolas, "Microsoft YaHei", monospace',scrollback:10000,theme:{background:'#171b20',foreground:'#e3e7ec',cursor:'#d7ad6e'}})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(el('terminal'))
let phase: 'idle'|'connecting'|'trust'|'ready'|'reconnecting' = 'idle'
let socket: WebSocket | undefined
let connectionId = '', lastSeq = 0, epoch = 0, fingerprint = ''
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectStarted = 0, attempt = 0
let scriptAbort: AbortController | undefined
let scriptRunning = false
let lastInputAccepted = true
const labels = {idle:'未连接',connecting:'正在连接…',trust:'等待核对指纹',ready:'已连接',reconnecting:'正在恢复网页连接…'}

function setPhase(value: typeof phase): void {
  phase=value
  status.textContent=labels[value]
  document.body.classList.toggle('connected',value==='ready'||value==='reconnecting')
  form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(item=>{item.disabled=value!=='idle'})
  el<HTMLButtonElement>('disconnect').disabled=value==='idle'
  el<HTMLButtonElement>('run-script').disabled=value!=='ready'||scriptRunning
  const textarea=el('terminal').querySelector('textarea')
  if(textarea)textarea.readOnly=value!=='ready'
  if(value!=='ready')scriptAbort?.abort()
  requestAnimationFrame(resize)
}
function send(message: object): boolean {
  if(!socket||socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>1024*1024)return false
  try{socket.send(JSON.stringify(message));return true}catch{return false}
}
function sendInput(text: string): boolean {
  if(phase!=='ready')return false
  for(let start=0;start<text.length;){
    let end=Math.min(text.length,start+16384)
    if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--
    if(!send({type:'input',data:text.slice(start,end)})){notice.textContent='输入未发送，连接尚未就绪或发送缓冲已满。请检查终端后再操作。';scriptAbort?.abort();return false}
    start=end
  }
  return true
}
term.onData(data=>{lastInputAccepted=sendInput(data)})
function resize(): void {
  try{fit.fit()}catch{return}
  if(phase==='ready')send({type:'resize',cols:term.cols,rows:term.rows})
}
let resizeFrame=0
new ResizeObserver(()=>{if(!resizeFrame)resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;resize()})}).observe(el('terminal'))

const errors: Record<string,string>={
  'SSH authentication failed':'SSH 认证失败，请检查用户名、密码或私钥。',
  'SSH connection failed':'SSH 连接失败，请检查主机、端口和网络。',
  'SSH connection timed out':'SSH 连接超时，请检查服务器是否可达。',
  'SSH input buffer full; input result is uncertain':'SSH 输入缓冲已满，连接已停止。已发送内容可能执行，请检查远端状态后再连接，不要重复发送。',
  'host key not trusted':'已拒绝服务器指纹。',
  'host key fingerprint mismatch':'服务器指纹不匹配，已停止连接。',
  'host key verification timed out':'指纹确认超时，请重新连接。',
  'connection not available':'可恢复的会话已过期，请重新连接 SSH。',
  'connection already attached':'该会话已在另一个页面使用。',
  'connection limit reached':'连接数已达上限，请先断开不再使用的会话。'
}
function forget(): void {connectionId='';lastSeq=0;try{sessionStorage.removeItem('web-ssh.connection')}catch{/* 存储可能禁用 */}}
function onMessage(candidate: WebSocket, event: MessageEvent): void {
  if(candidate!==socket||typeof event.data!=='string')return
  let message: Record<string,unknown>
  try{message=JSON.parse(event.data);if(!message||Array.isArray(message)||typeof message!=='object')return}catch{return}
  if(message.type==='host-key'){
    if(typeof message.fingerprint!=='string'||!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(message.fingerprint))return
    fingerprint=message.fingerprint
    el('fingerprint').textContent=fingerprint
    el('key-host').textContent=`${String(message.host)}:${String(message.port)} · ${String(message.algorithm)}`
    el('trust').hidden=false
    setPhase('trust')
    notice.textContent='正在等待你核对服务器指纹，尚未继续认证。'
  }else if(message.type==='ready'&&typeof message.connectionId==='string'&&message.connectionId.length<=64){
    connectionId=message.connectionId
    try{sessionStorage.setItem('web-ssh.connection',connectionId)}catch{/* 不影响当前连接 */}
    el('trust').hidden=true
    reconnectStarted=0;attempt=0
    setPhase('ready');resize()
    notice.textContent='已连接。断线后仅恢复输出，不重发命令；已输入不代表执行完成。'
    term.focus()
  }else if(message.type==='data'&&typeof message.data==='string'&&Number.isSafeInteger(message.seq)&&Number(message.seq)>lastSeq){
    lastSeq=Number(message.seq);term.write(message.data)
  }else if(message.type==='gap'&&Number.isSafeInteger(message.nextSeq)){
    lastSeq=Number(message.nextSeq)-1
    term.writeln('\r\n\x1b[33m[离线期间部分旧输出已超出缓存，以下为仍可恢复的内容]\x1b[0m')
    notice.textContent='输出缓存出现缺口，请检查远端状态；命令不会自动重发。'
  }else if(message.type==='error'||message.type==='closed'){
    const text=typeof message.message==='string'?errors[message.message]:undefined
    forget();el('trust').hidden=true;setPhase('idle')
    notice.textContent=text||(message.type==='closed'?'SSH 会话已关闭。':'操作失败，请检查服务器连接和认证信息。')
    candidate.close()
  }
}
async function openSocket(version: number): Promise<WebSocket> {
  const response=await fetch('/api/ticket',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)})
  if(!response.ok)throw Error('ticket')
  const data=await response.json() as {ticket?:unknown}
  if(version!==epoch||typeof data.ticket!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(data.ticket))throw Error('stale')
  const candidate=new WebSocket(`ws://${location.host}/terminal`,['lyshell-web-ssh',data.ticket])
  socket=candidate
  candidate.addEventListener('message',event=>onMessage(candidate,event))
  candidate.addEventListener('close',()=>{
    if(candidate!==socket||version!==epoch)return
    if(connectionId){scheduleReconnect(version);return}
    el('trust').hidden=true
    setPhase('idle')
    notice.textContent='网页连接已中断，请重新连接 SSH。'
  })
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{candidate.close();reject(Error('timeout'))},10000)
    candidate.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})
    candidate.addEventListener('error',()=>{clearTimeout(timer);reject(Error('socket'))},{once:true})
    candidate.addEventListener('close',()=>{clearTimeout(timer);reject(Error('closed'))},{once:true})
  })
  if(version!==epoch){candidate.close();throw Error('stale')}
  return candidate
}
function scheduleReconnect(version: number): void {
  if(version!==epoch||!connectionId||reconnectTimer)return
  if(!reconnectStarted)reconnectStarted=Date.now()
  if(Date.now()-reconnectStarted>55000){forget();setPhase('idle');notice.textContent='网页连接未能恢复，请重新连接 SSH。';return}
  setPhase('reconnecting');notice.textContent='正在恢复本地网页通道。输入已暂停，不会自动重发。'
  reconnectTimer=setTimeout(()=>{
    reconnectTimer=undefined
    void openSocket(version).then(()=>{if(!send({type:'resume',connectionId,lastSeq}))throw Error('resume')}).catch(()=>scheduleReconnect(version))
  },Math.min(5000,500*2**attempt++))
}

form.addEventListener('submit',event=>{
  event.preventDefault()
  if(phase!=='idle')return
  const version=++epoch
  forget();term.reset();setPhase('connecting');notice.textContent='正在建立本地网页通道…'
  void(async()=>{
    const host=input('host').value.trim(),port=Number(input('port').value),username=input('username').value.trim()
    if(!host||!username||!Number.isInteger(port)||port<1||port>65535)throw Error('form')
    const config: Record<string,unknown>={type:'connect',host,port,username,cols:term.cols,rows:term.rows}
    if(el<HTMLSelectElement>('auth').value==='key'){
      const file=input('key-file').files?.[0]
      if(!file||file.size>65536)throw Error('key')
      config.privateKey=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())
      if(input('passphrase').value)config.passphrase=input('passphrase').value
    }else if(input('password').value)config.password=input('password').value
    await openSocket(version)
    if(version!==epoch)return
    el('target').textContent=`${username}@${host}:${port}`
    if(!send(config))throw Error('send')
    input('password').value='';input('passphrase').value='';input('key-file').value=''
    config.password=undefined;config.privateKey=undefined;config.passphrase=undefined
    notice.textContent='正在连接 SSH，等待服务器指纹…'
  })().catch(()=>{if(version===epoch){socket?.close();setPhase('idle');notice.textContent='连接未建立，请检查输入、私钥文件或本地服务状态。'}})
})
el('auth').addEventListener('change',()=>{const key=el<HTMLSelectElement>('auth').value==='key';el('key-fields').hidden=!key;el('password-field').hidden=key})
el('trust-yes').addEventListener('click',()=>{if(phase==='trust'&&send({type:'trust-host',fingerprint,accept:true})){el('trust').hidden=true;setPhase('connecting');notice.textContent='已确认本次指纹，正在认证…'}})
el('trust-no').addEventListener('click',()=>{send({type:'trust-host',fingerprint,accept:false});el('trust').hidden=true})
el('disconnect').addEventListener('click',()=>{
  const old=connectionId,version=++epoch
  if(reconnectTimer)clearTimeout(reconnectTimer)
  reconnectTimer=undefined;reconnectStarted=0;attempt=0
  send({type:'disconnect'});socket?.close();socket=undefined;forget();el('trust').hidden=true;setPhase('idle');notice.textContent='已断开。'
  if(old)void fetch('/api/disconnect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:old}),signal:AbortSignal.timeout(10000)}).then(response=>{if(!response.ok&&response.status!==404&&version===epoch)notice.textContent='本地已停止重连；未确认网关回收，会话将在超时后关闭。'}).catch(()=>{if(version===epoch)notice.textContent='本地已停止重连；网关恢复后会按超时回收会话。'})
})

el('run-script').addEventListener('click',()=>{
  if(phase!=='ready'||scriptRunning)return
  const text=el<HTMLTextAreaElement>('script').value
  const lines=text.replace(/\r\n?/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop()
  if(!text||text.length>65536||!isWebTerminalText(text)||lines.some(line=>line.length>16384)){el('script-status').textContent='请输入不含控制字符的文本，每行最多 16384 字符。';return}
  const delay=Math.max(50,Math.min(3000,Number(input('delay').value)||150)),controller=new AbortController()
  scriptAbort=controller;scriptRunning=true;el<HTMLButtonElement>('run-script').disabled=true;el<HTMLButtonElement>('stop-script').disabled=false
  el<HTMLTextAreaElement>('script').disabled=true
  void(async()=>{
    let count=0
    for(const line of lines){
      if(controller.signal.aborted||phase!=='ready')break
      lastInputAccepted=true
      if(line)term.paste(line)
      if(!lastInputAccepted)break
      if(!sendInput('\r'))break
      count++;el('script-status').textContent=`已输入 ${count} / ${lines.length} 行`
      if(count<lines.length)await new Promise<void>(resolve=>{const done=():void=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,delay);controller.signal.addEventListener('abort',done,{once:true})})
    }
    el('script-status').textContent=`${count===lines.length?'已输入':'已停止'} ${count} / ${lines.length} 行，请在终端确认执行结果。`
  })().finally(()=>{scriptRunning=false;el<HTMLButtonElement>('run-script').disabled=phase!=='ready';el<HTMLButtonElement>('stop-script').disabled=true;el<HTMLTextAreaElement>('script').disabled=false})
})
el('stop-script').addEventListener('click',()=>scriptAbort?.abort())
setPhase('idle')
try{const saved=sessionStorage.getItem('web-ssh.connection');if(saved&&/^[a-f0-9]{32}$/.test(saved)){connectionId=saved;scheduleReconnect(epoch)}}catch{/* 不支持 sessionStorage 时从新连接开始 */}
