(function () {
  'use strict'
  var bridge=window.lyshellView, button=document.getElementById('open'), state=document.getElementById('state'), url=''
  if(!bridge){state.textContent='请在 LyShell 插件视图内打开。';return}
  bridge.bootstrap().then(function(boot){document.documentElement.dataset.theme=boot.theme;return fetch('runtime.json',{cache:'no-store'})}).then(function(response){if(!response.ok)throw Error();return response.json()}).then(function(config){
    if(!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error()
    url='http://127.0.0.1:'+config.port
    state.textContent='本机服务：'+url
    button.disabled=false
  }).catch(function(){state.textContent='服务尚未就绪，请检查插件日志或重新启用插件。'})
  bridge.onEvent(function(event){if(event.type==='themeChanged')document.documentElement.dataset.theme=event.theme})
  button.addEventListener('click',function(){bridge.openWebTab(url).then(function(result){if(!result.ok)state.textContent='打开失败，请检查 uiControl 权限。'}).catch(function(){state.textContent='无法打开网页终端。'})})
})()
